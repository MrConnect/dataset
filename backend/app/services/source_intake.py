"""Accepting a user-supplied source video for a job.

Every path that hands the pipeline a local file (chunked browser upload,
legacy multipart upload) goes through ``attach_source_to_job`` so the file is
verified exactly once, in one place, before the job is re-queued.
"""

import asyncio
import shutil
from pathlib import Path
from urllib.parse import unquote, urlparse

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.job import Job
from app.services.media_probe import MediaInfo, probe_video
from app.services.thumbnails import ThumbnailWorker

ALLOWED_VIDEO_SUFFIXES = {".mp4", ".mkv", ".mov", ".webm", ".ts", ".m4v", ".avi"}

# URL prefixes under which this server exposes its own source library.
_LIBRARY_URL_PREFIXES = ("/api/v1/dataset/file/_downloads/", "/storage/downloads/")


class SourceRejected(Exception):
    """The supplied file cannot be used; ``status_code`` maps to the HTTP reply."""

    def __init__(self, detail: str, status_code: int = 422):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def format_timestamp(seconds: float) -> str:
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def video_suffix(filename: str) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in ALLOWED_VIDEO_SUFFIXES:
        allowed = ", ".join(sorted(ALLOWED_VIDEO_SUFFIXES))
        raise SourceRejected(f"Unsupported video file type. Allowed: {allowed}", status_code=415)
    return suffix


def find_library_source(media_url: str | None) -> Path | None:
    """Map a URL of this server's own source library to the file on disk.

    Lets a video that was tagged while playing from the dashboard be cut
    directly, without the server downloading from itself over HTTP.
    """
    if not media_url:
        return None
    path = unquote(urlparse(media_url).path)
    for prefix in _LIBRARY_URL_PREFIXES:
        if path.startswith(prefix):
            name = path[len(prefix):]
            if not name or name in {".", ".."} or "/" in name or "\\" in name:
                return None
            candidate = Path(settings.BASE_STORAGE_DIR) / "downloads" / name
            return candidate if candidate.is_file() else None
    return None


async def probe_source(path: Path) -> MediaInfo:
    try:
        return await probe_video(path)
    except FileNotFoundError as exc:
        raise SourceRejected("The uploaded file is empty or incomplete.") from exc
    except ValueError as exc:
        raise SourceRejected(f"The uploaded file is not a playable video: {exc}") from exc
    except (RuntimeError, TimeoutError) as exc:
        raise SourceRejected(f"The server could not verify the video: {exc}", status_code=503) from exc


def ensure_job_accepts_source(job: Job) -> None:
    if job.status in ("completed", "processing", "downloading"):
        raise SourceRejected(
            f"Job is already {job.status}. Cancel it first if you want to replace its source.",
            status_code=409,
        )


async def attach_source_to_job(
    db: AsyncSession,
    job: Job,
    staged_path: Path,
    suffix: str,
) -> dict:
    """Verify ``staged_path`` against the job and queue the job to run on it.

    On rejection the staged file is left in place for the caller to remove.
    """
    ensure_job_accepts_source(job)
    info = await probe_source(staged_path)

    furthest_end = max((segment.end_seconds for segment in job.segments), default=0.0)
    if furthest_end > info.duration + 0.05:
        raise SourceRejected(
            f"This video is {format_timestamp(info.duration)} long, but the job has a segment ending at "
            f"{format_timestamp(furthest_end)}. It does not look like the same video."
        )

    warning = None
    expected = job.duration_seconds
    if expected and expected > 0:
        drift = abs(info.duration - expected)
        if drift > max(3.0, expected * 0.03):
            warning = (
                f"The uploaded video is {format_timestamp(info.duration)} long while the tagged video was "
                f"{format_timestamp(expected)}. Cuts use the uploaded file's timeline — check the results."
            )

    destination = settings.downloads_path / f"{job.id}_source{suffix}"
    for stale in (
        *settings.temp_path.glob(f"{job.id}_uploaded_source.*"),
        *settings.downloads_path.glob(f"{job.id}_source.*"),
    ):
        if stale != staged_path:
            stale.unlink(missing_ok=True)
    await asyncio.to_thread(shutil.move, str(staged_path), str(destination))
    ThumbnailWorker.schedule("_downloads", destination.name)

    job.source_file_path = str(destination)
    job.acquisition_mode = "upload"
    job.status = "queued"
    job.progress = 0
    job.error = warning
    job.failure_code = None
    for segment in job.segments:
        segment.status = "pending"
        segment.error = None
    await db.commit()

    return {
        "job_id": job.id,
        "status": "queued",
        "duration_seconds": info.duration,
        "width": info.width,
        "height": info.height,
        "warning": warning,
        "message": "Source verified; processing resumed",
    }
