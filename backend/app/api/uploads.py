"""Resumable chunked uploads from the browser.

Flow::

    POST   /api/v1/uploads                 {filename, size, job_id?}  -> upload_id, chunk_size
    PUT    /api/v1/uploads/{id}?offset=N   raw bytes                  -> received
    GET    /api/v1/uploads/{id}                                       -> received (to resume)
    POST   /api/v1/uploads/{id}/complete                              -> verified result
    DELETE /api/v1/uploads/{id}                                       -> abort

With ``job_id`` the finished file becomes that job's source: it is verified
with FFprobe, checked against the job's segments, and the job is re-queued.
Without it the file is added to the source library.
"""

import asyncio
import shutil
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect

from app.api.dataset import DOWNLOADS_CATEGORY, file_url, validate_path_component
from app.api.routes import _dispatch
from app.config import settings
from app.core.security import Principal, verify_api_key
from app.db.session import get_db
from app.models.job import Job
from app.services import upload_sessions
from app.services.source_intake import (
    SourceRejected,
    attach_source_to_job,
    ensure_job_accepts_source,
    probe_source,
    video_suffix,
)
from app.services.thumbnails import ThumbnailWorker
from app.services.upload_sessions import UploadError

router = APIRouter(prefix="/api/v1/uploads", tags=["Uploads"])

ApiKeyAuth = Annotated[Principal, Depends(verify_api_key)]


class UploadCreateRequest(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    size: int = Field(..., gt=0)
    job_id: str | None = Field(None, max_length=64)


def _http_error(error: UploadError | SourceRejected) -> HTTPException:
    detail: object = error.detail
    received = getattr(error, "received", None)
    if received is not None:
        detail = {"message": error.detail, "received": received}
    return HTTPException(status_code=error.status_code, detail=detail)


def _load(upload_id: str) -> upload_sessions.UploadSession:
    try:
        return upload_sessions.load_session(upload_id)
    except UploadError as error:
        raise _http_error(error) from error


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_upload(
    req: UploadCreateRequest,
    _auth: ApiKeyAuth,
    db: AsyncSession = Depends(get_db),
):
    filename = validate_path_component(req.filename, "filename")
    try:
        video_suffix(filename)
        if req.job_id:
            job = await db.get(Job, req.job_id)
            if not job:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
            ensure_job_accepts_source(job)
        elif (settings.downloads_path / filename).exists():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A file with this name already exists")
        session = upload_sessions.create_session(filename, req.size, req.job_id)
    except (UploadError, SourceRejected) as error:
        raise _http_error(error) from error
    return session.describe()


@router.get("/{upload_id}")
async def get_upload(upload_id: str, _auth: ApiKeyAuth):
    return _load(upload_id).describe()


@router.put("/{upload_id}")
async def upload_chunk(
    upload_id: str,
    request: Request,
    _auth: ApiKeyAuth,
    offset: int = Query(..., ge=0),
):
    session = _load(upload_id)
    try:
        received = await upload_sessions.append_chunk(session, offset, request.stream())
    except UploadError as error:
        raise _http_error(error) from error
    except ClientDisconnect:
        # Bytes written so far are kept; the client resumes from `received`.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Connection closed mid-chunk")
    return {"upload_id": session.id, "received": received, "size": session.size}


@router.post("/{upload_id}/complete")
async def complete_upload(
    upload_id: str,
    _auth: ApiKeyAuth,
    db: AsyncSession = Depends(get_db),
):
    session = _load(upload_id)
    received = session.received
    if received != session.size:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "Upload is not complete yet", "received": received},
        )

    try:
        suffix = video_suffix(session.filename)
        if session.job_id:
            job = await db.get(Job, session.job_id)
            if not job:
                raise SourceRejected("The job this upload belongs to no longer exists", status_code=404)
            result = await attach_source_to_job(db, job, session.part_path, suffix)
            await _dispatch(job.id)
        else:
            info = await probe_source(session.part_path)
            destination = settings.downloads_path / session.filename
            if destination.exists():
                raise SourceRejected("A file with this name already exists", status_code=409)
            await asyncio.to_thread(shutil.move, str(session.part_path), str(destination))
            ThumbnailWorker.schedule(DOWNLOADS_CATEGORY, session.filename)
            result = {
                "ok": True,
                "filename": session.filename,
                "size": session.size,
                "duration_seconds": info.duration,
                "width": info.width,
                "height": info.height,
                "url": file_url(DOWNLOADS_CATEGORY, session.filename),
            }
    except SourceRejected as rejected:
        # A rejected file can never become valid; drop it so the user can retry
        # cleanly. A server-side fault (503) keeps the bytes so only the
        # verification has to be retried.
        if rejected.status_code != 503:
            upload_sessions.discard_session(session)
        raise _http_error(rejected) from rejected

    upload_sessions.discard_session(session)
    return result


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
async def abort_upload(upload_id: str, _auth: ApiKeyAuth):
    upload_sessions.discard_session(_load(upload_id))
