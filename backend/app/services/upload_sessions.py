"""Resumable chunked uploads.

A browser sends a multi-gigabyte video as a series of small PUT requests.
Each session is a ``<id>.part`` file plus a ``<id>.json`` descriptor in the
temp directory, so an interrupted upload survives a dropped connection, a
reverse-proxy timeout or a server restart and resumes from the byte count the
server reports.
"""

import asyncio
import json
import re
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import AsyncIterator

from app.config import settings

_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
_locks: dict[str, asyncio.Lock] = {}


class UploadError(Exception):
    def __init__(self, detail: str, status_code: int = 400, received: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code
        self.received = received


@dataclass
class UploadSession:
    id: str
    filename: str
    size: int
    job_id: str | None
    created_at: float

    @property
    def part_path(self) -> Path:
        return settings.uploads_path / f"{self.id}.part"

    @property
    def meta_path(self) -> Path:
        return settings.uploads_path / f"{self.id}.json"

    @property
    def received(self) -> int:
        try:
            return self.part_path.stat().st_size
        except OSError:
            return 0

    def describe(self) -> dict:
        return {
            "upload_id": self.id,
            "filename": self.filename,
            "size": self.size,
            "received": self.received,
            "job_id": self.job_id,
            "chunk_size": settings.UPLOAD_CHUNK_BYTES,
        }


def _lock_for(upload_id: str) -> asyncio.Lock:
    return _locks.setdefault(upload_id, asyncio.Lock())


def create_session(filename: str, size: int, job_id: str | None) -> UploadSession:
    if size <= 0:
        raise UploadError("File is empty")
    if size > settings.MAX_DOWNLOAD_SIZE_BYTES:
        raise UploadError(
            f"File is too large (limit {settings.MAX_DOWNLOAD_SIZE_BYTES // (1024 * 1024)} MB)",
            status_code=413,
        )
    session = UploadSession(
        id=uuid.uuid4().hex,
        filename=filename,
        size=size,
        job_id=job_id,
        created_at=time.time(),
    )
    session.part_path.touch()
    session.meta_path.write_text(json.dumps(asdict(session)), encoding="utf-8")
    return session


def load_session(upload_id: str) -> UploadSession:
    if not _ID_PATTERN.match(upload_id or ""):
        raise UploadError("Upload not found", status_code=404)
    meta_path = settings.uploads_path / f"{upload_id}.json"
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        return UploadSession(**data)
    except (OSError, ValueError, TypeError) as exc:
        raise UploadError("Upload not found or expired", status_code=404) from exc


async def append_chunk(session: UploadSession, offset: int, body: AsyncIterator[bytes]) -> int:
    """Append a chunk that must start exactly where the stored bytes end.

    If the connection drops mid-chunk the bytes already written are kept; the
    client asks for ``received`` and continues from there.
    """
    async with _lock_for(session.id):
        current = session.received
        if offset != current:
            raise UploadError(
                "Chunk offset does not match the bytes already received",
                status_code=409,
                received=current,
            )
        written = current
        with session.part_path.open("ab") as output:
            async for chunk in body:
                if not chunk:
                    continue
                if written + len(chunk) > session.size:
                    output.flush()
                    output.truncate(current)
                    raise UploadError(
                        "More data was sent than the declared file size",
                        status_code=413,
                        received=current,
                    )
                output.write(chunk)
                written += len(chunk)
        return written


def discard_session(session: UploadSession) -> None:
    session.part_path.unlink(missing_ok=True)
    session.meta_path.unlink(missing_ok=True)
    _locks.pop(session.id, None)


def cleanup_stale_sessions() -> int:
    """Remove uploads abandoned for longer than the session TTL."""
    removed = 0
    cutoff = time.time() - settings.UPLOAD_SESSION_TTL_SECONDS
    for item in settings.uploads_path.iterdir():
        try:
            if item.is_file() and item.stat().st_mtime < cutoff:
                item.unlink()
                removed += 1
        except OSError:
            continue
    return removed
