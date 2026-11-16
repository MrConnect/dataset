"""Video thumbnails that follow their files like a file manager's cache.

Layout mirrors the library: ``<storage>/thumbs/<category>/<filename>.jpg``.
Because the cache is addressed by the file's location, keeping it in sync is
a rename or unlink next to the real operation:

* delete  -> ``remove_thumbnail``
* move / rename -> ``move_thumbnail`` (the image is reused, not regenerated)
* file replaced in place -> detected by mtime and regenerated
* anything missed (job purge, manual deletes) -> ``sweep_orphans`` hourly

Each thumbnail is rendered **once**, right after its video is created (a cut
clip, a downloaded or uploaded source), by ``ThumbnailWorker`` in the
background. Requests only read the cached file. A thumbnail that goes missing
is rebuilt by the periodic ``backfill`` or, as a last resort, on request.

Rendering is deliberately gentle on the machine: one FFmpeg process at a
time, single-threaded, at low OS priority, decoding a single frame after a
fast seek, with a pause between renders. Files that cannot be thumbnailed get
a marker so they are not retried.
"""

import asyncio
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from app.config import settings

logger = logging.getLogger("thumbnails")

THUMB_WIDTH = 320
THUMBNAIL_SUFFIXES = {".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ts", ".avi"}
GENERATION_TIMEOUT_SECONDS = 30

_semaphores: dict[int, asyncio.Semaphore] = {}
_inflight: dict[str, asyncio.Future] = {}


def thumbs_root() -> Path:
    root = Path(settings.BASE_STORAGE_DIR) / "thumbs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def thumb_path(category: str, filename: str) -> Path:
    return thumbs_root() / category / f"{filename}.jpg"


def _fail_marker(category: str, filename: str) -> Path:
    return thumbs_root() / category / f"{filename}.fail"


def can_thumbnail(filename: str) -> bool:
    return Path(filename).suffix.lower() in THUMBNAIL_SUFFIXES


def _is_fresh(cached: Path, source: Path) -> bool:
    try:
        return cached.stat().st_mtime >= source.stat().st_mtime
    except OSError:
        return False


def source_dir(category: str) -> Path | None:
    """Directory holding a library category's files, or None for non-library categories."""
    if category == "_downloads":
        return Path(settings.BASE_STORAGE_DIR) / "downloads"
    if not category or category.startswith("_") or category == "metadata" or "/" in category or "\\" in category:
        return None
    return Path(settings.DATASET_DIR) / category


def is_ready(category: str, filename: str, source: Path) -> bool:
    """True when a current thumbnail is already cached (no render needed)."""
    return _is_fresh(thumb_path(category, filename), source)


def _needs_render(category: str, filename: str, source: Path) -> bool:
    return not is_ready(category, filename, source) and not _is_fresh(_fail_marker(category, filename), source)


def _semaphore() -> asyncio.Semaphore:
    # One generator at a time per event loop (tests create a loop per test).
    loop_id = id(asyncio.get_running_loop())
    if loop_id not in _semaphores:
        _semaphores.clear()
        _semaphores[loop_id] = asyncio.Semaphore(1)
    return _semaphores[loop_id]


def _low_priority_kwargs() -> dict:
    if sys.platform == "win32":
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW}
    return {}


def _render(source: Path, destination: Path) -> bool:
    """Blocking: write one scaled frame of ``source`` to ``destination``."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FileNotFoundError("ffmpeg is not installed")

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    prefix = ["nice", "-n", "19"] if sys.platform != "win32" and shutil.which("nice") else []

    # Try one second in (skips black lead-in frames), then the very first
    # frame for clips shorter than that.
    for seek in ("1", "0"):
        cmd = [
            *prefix, ffmpeg, "-v", "error", "-nostdin", "-y",
            "-threads", "1",
            "-ss", seek,
            "-i", str(source),
            "-map", "0:v:0",
            "-frames:v", "1",
            "-vf", f"scale={THUMB_WIDTH}:-2:flags=fast_bilinear",
            "-q:v", "6",
            "-an", "-sn",
            "-f", "mjpeg",
            str(partial),
        ]
        try:
            subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=GENERATION_TIMEOUT_SECONDS,
                **_low_priority_kwargs(),
            )
        except subprocess.TimeoutExpired:
            partial.unlink(missing_ok=True)
            return False
        if partial.exists() and partial.stat().st_size > 0:
            os.replace(partial, destination)
            return True
        partial.unlink(missing_ok=True)
    return False


async def ensure_thumbnail(category: str, filename: str, source: Path) -> Path | None:
    """Return the cached thumbnail for ``source``, generating it if needed.

    Returns None when no thumbnail can be produced (not a video, unreadable,
    or FFmpeg unavailable).
    """
    if not can_thumbnail(filename):
        return None

    cached = thumb_path(category, filename)
    if _is_fresh(cached, source):
        return cached
    marker = _fail_marker(category, filename)
    if _is_fresh(marker, source):
        return None

    key = str(cached)
    pending = _inflight.get(key)
    if pending is not None:
        return await pending

    future: asyncio.Future = asyncio.get_running_loop().create_future()
    _inflight[key] = future
    result: Path | None = None
    try:
        async with _semaphore():
            if not source.is_file():
                return None
            try:
                ok = await asyncio.to_thread(_render, source, cached)
            except FileNotFoundError:
                return None  # ffmpeg missing: transient, do not mark the file as bad
            if ok and source.is_file():
                marker.unlink(missing_ok=True)
                result = cached
            elif ok:
                cached.unlink(missing_ok=True)  # the file was deleted while rendering
            else:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.touch()
        return result
    except Exception:
        logger.warning("Thumbnail generation failed for %s/%s", category, filename, exc_info=True)
        return None
    finally:
        _inflight.pop(key, None)
        if not future.done():
            future.set_result(result)


def _prune_empty(directory: Path) -> None:
    try:
        if directory != thumbs_root() and directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
    except OSError:
        pass


def remove_thumbnail(category: str, filename: str) -> None:
    for path in (thumb_path(category, filename), _fail_marker(category, filename)):
        path.unlink(missing_ok=True)
    _prune_empty(thumbs_root() / category)


def move_thumbnail(old_category: str, old_filename: str, new_category: str, new_filename: str) -> None:
    """Carry the cached image along with a moved or renamed file."""
    pairs = (
        (thumb_path(old_category, old_filename), thumb_path(new_category, new_filename)),
        (_fail_marker(old_category, old_filename), _fail_marker(new_category, new_filename)),
    )
    for old, new in pairs:
        try:
            if old.exists():
                new.parent.mkdir(parents=True, exist_ok=True)
                os.replace(old, new)
            else:
                new.unlink(missing_ok=True)  # never show a stale image for the new name
        except OSError:
            old.unlink(missing_ok=True)
    _prune_empty(thumbs_root() / old_category)


def remove_category(category: str) -> None:
    shutil.rmtree(thumbs_root() / category, ignore_errors=True)


def sweep_orphans(source_dir_for) -> int:
    """Delete cached images whose video no longer exists.

    ``source_dir_for(category)`` returns the directory holding that category's
    files, or None when the category is unknown.
    """
    removed = 0
    root = thumbs_root()
    for category_dir in root.iterdir():
        if not category_dir.is_dir():
            continue
        source_dir = source_dir_for(category_dir.name)
        for cached in list(category_dir.iterdir()):
            if cached.suffix not in {".jpg", ".fail", ".part"}:
                continue
            original = source_dir / cached.stem if source_dir else None
            if original is None or not original.is_file():
                try:
                    cached.unlink()
                    removed += 1
                except OSError:
                    pass
        _prune_empty(category_dir)
    return removed


def copy_thumbnail(cached: Path, category: str, filename: str) -> None:
    """Reuse an image for an identical file stored under another category."""
    target = thumb_path(category, filename)
    if target == cached:
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cached, target)
    except OSError:
        pass


def find_missing() -> list[tuple[str, str]]:
    """Library videos whose thumbnail is missing or stale (blocking; run in a thread)."""
    missing: list[tuple[str, str]] = []
    roots: list[tuple[str, Path]] = []
    dataset = Path(settings.DATASET_DIR)
    if dataset.is_dir():
        roots.extend(
            (directory.name, directory)
            for directory in dataset.iterdir()
            if directory.is_dir() and source_dir(directory.name) is not None
        )
    downloads = source_dir("_downloads")
    if downloads is not None and downloads.is_dir():
        roots.append(("_downloads", downloads))

    for category, directory in roots:
        for file in directory.iterdir():
            try:
                if file.is_file() and can_thumbnail(file.name) and _needs_render(category, file.name, file):
                    missing.append((category, file.name))
            except OSError:
                continue
    return missing


class ThumbnailWorker:
    """Single background renderer fed by file-creation events and backfills."""

    PAUSE_AFTER_RENDER_SECONDS = 0.25

    _queue: asyncio.Queue | None = None
    _task: asyncio.Task | None = None
    _queued: set[tuple[str, str]] = set()

    @classmethod
    def start(cls) -> None:
        if cls._task is not None:
            return
        cls._queue = asyncio.Queue()
        cls._queued = set()
        cls._task = asyncio.create_task(cls._run())

    @classmethod
    async def stop(cls) -> None:
        task, cls._task = cls._task, None
        cls._queue = None
        cls._queued = set()
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    @classmethod
    def schedule(cls, category: str, filename: str, also: list[tuple[str, str]] | tuple = ()) -> None:
        """Queue a render for a newly created file.

        ``also`` lists other (category, filename) locations holding the same
        video (hard links or copies); they receive a copy of the image instead
        of a second render. Outside the web process (Celery) there is no
        worker and this is a no-op: the backfill catches those files.
        """
        if cls._queue is None or not can_thumbnail(filename) or source_dir(category) is None:
            return
        key = (category, filename)
        if key in cls._queued:
            return
        cls._queued.add(key)
        cls._queue.put_nowait((category, filename, tuple(also)))

    @classmethod
    async def backfill(cls) -> int:
        """Queue every library video that has no current thumbnail."""
        if cls._queue is None:
            return 0
        missing = await asyncio.to_thread(find_missing)
        for category, filename in missing:
            cls.schedule(category, filename)
        if missing:
            logger.info("Queued %d missing thumbnail(s)", len(missing))
        return len(missing)

    @classmethod
    async def drain(cls) -> None:
        """Wait until the queue is empty (used by tests)."""
        if cls._queue is not None:
            await cls._queue.join()

    @classmethod
    async def _run(cls) -> None:
        queue = cls._queue
        while queue is not None:
            category, filename, also = await queue.get()
            cls._queued.discard((category, filename))
            rendered = False
            try:
                directory = source_dir(category)
                source = directory / filename if directory else None
                if source is not None and source.is_file():
                    rendered = _needs_render(category, filename, source)
                    cached = await ensure_thumbnail(category, filename, source)
                    if cached is not None:
                        for other_category, other_filename in also:
                            copy_thumbnail(cached, other_category, other_filename)
            except Exception:
                logger.warning("Background thumbnail failed for %s/%s", category, filename, exc_info=True)
            finally:
                queue.task_done()
            if rendered:
                await asyncio.sleep(cls.PAUSE_AFTER_RENDER_SECONDS)
