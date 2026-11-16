"""Session, client-key management and database maintenance."""

import asyncio
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from app.config import settings
from app.core.security import (
    MEDIA_COOKIE_NAME,
    MEDIA_COOKIE_TTL_SECONDS,
    Principal,
    create_media_session_token,
    generate_client_key,
    hash_key,
    open_client_key,
    seal_client_key,
    require_admin,
    verify_api_key,
)
from app.db.session import engine, get_db
from app.models.job import ApiKey, CategoryModel, Job, JobSegment
from app.workers.queue import JobWorkerQueue

router = APIRouter(prefix="/api/v1")

AnyKey = Annotated[Principal, Depends(verify_api_key)]
AdminKey = Annotated[Principal, Depends(require_admin)]


# --- session ---------------------------------------------------------------

@router.get("/auth/me", tags=["Auth"])
async def who_am_i(principal: AnyKey):
    return {"role": principal.role, "name": principal.name}


@router.post("/auth/session", tags=["Auth"])
async def start_media_session(request: Request, response: Response, principal: AnyKey):
    """Exchange a valid key for a cookie that only unlocks file GET routes."""
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    secure = request.url.scheme == "https" or forwarded == "https"
    response.set_cookie(
        MEDIA_COOKIE_NAME,
        create_media_session_token(),
        max_age=MEDIA_COOKIE_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        secure=secure,
        path="/api/v1/dataset",
    )
    return {"role": principal.role, "expires_in": MEDIA_COOKIE_TTL_SECONDS}


@router.delete("/auth/session", status_code=status.HTTP_204_NO_CONTENT, tags=["Auth"])
async def end_media_session(response: Response):
    response.delete_cookie(MEDIA_COOKIE_NAME, path="/api/v1/dataset")


# --- client keys -----------------------------------------------------------

class KeyCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)


class KeyInfo(BaseModel):
    id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    revealable: bool = False


class KeyCreated(KeyInfo):
    key: str


def _key_info(record: ApiKey) -> KeyInfo:
    return KeyInfo(
        id=record.id,
        name=record.name,
        prefix=record.prefix,
        created_at=record.created_at,
        last_used_at=record.last_used_at,
        revealable=bool(record.key_encrypted),
    )


@router.get("/keys", response_model=list[KeyInfo], tags=["Keys"])
async def list_keys(_admin: AdminKey, db: AsyncSession = Depends(get_db)):
    records = (await db.execute(select(ApiKey).order_by(ApiKey.created_at.desc()))).scalars().all()
    return [_key_info(record) for record in records]


@router.post("/keys", response_model=KeyCreated, status_code=status.HTTP_201_CREATED, tags=["Keys"])
async def create_key(req: KeyCreateRequest, _admin: AdminKey, db: AsyncSession = Depends(get_db)):
    """Create a client key. It can be shown again later by the admin."""
    plaintext = generate_client_key()
    record = ApiKey(
        id=uuid.uuid4().hex[:16],
        name=req.name.strip(),
        key_hash=hash_key(plaintext),
        prefix=plaintext[:10],
        key_encrypted=seal_client_key(plaintext),
    )
    db.add(record)
    await db.commit()
    return KeyCreated(**_key_info(record).model_dump(), key=plaintext)


@router.get("/keys/{key_id}/reveal", tags=["Keys"])
async def reveal_key(key_id: str, response: Response, _admin: AdminKey, db: AsyncSession = Depends(get_db)):
    """Show a client key again (admin only)."""
    record = await db.get(ApiKey, key_id)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")
    plaintext = open_client_key(record.key_encrypted)
    if plaintext is None or hash_key(plaintext) != record.key_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This key can't be shown again (it was created before keys were stored, or the admin key changed). "
                   "It still works; create a new one if you need to see it.",
        )
    response.headers["Cache-Control"] = "no-store"
    return {"id": record.id, "key": plaintext}


@router.delete("/keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Keys"])
async def revoke_key(key_id: str, _admin: AdminKey, db: AsyncSession = Depends(get_db)):
    record = await db.get(ApiKey, key_id)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Key not found")
    await db.delete(record)
    await db.commit()


# --- database --------------------------------------------------------------

def _sqlite_path() -> Path | None:
    if not settings.DATABASE_URL.startswith("sqlite"):
        return None
    return Path(settings.DATABASE_URL.split("///", 1)[-1])


@router.get("/system/database", tags=["System"])
async def database_info(_admin: AdminKey, db: AsyncSession = Depends(get_db)):
    path = _sqlite_path()
    counts = {}
    for label, model in (("jobs", Job), ("segments", JobSegment), ("categories", CategoryModel), ("keys", ApiKey)):
        counts[label] = (await db.execute(select(func.count()).select_from(model))).scalar_one()
    return {
        "engine": "sqlite" if path else "external",
        "filename": path.name if path else None,
        "size": path.stat().st_size if path and path.exists() else None,
        "downloadable": bool(path and path.exists()),
        **counts,
    }


@router.get("/system/database/download", tags=["System"])
async def download_database(_admin: AdminKey):
    path = _sqlite_path()
    if not path or not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No downloadable SQLite database")

    snapshot = settings.temp_path / f"db_snapshot_{uuid.uuid4().hex[:8]}.db"

    def take_snapshot() -> None:
        # The backup API yields a consistent copy even while jobs are writing.
        source = sqlite3.connect(str(path))
        try:
            target = sqlite3.connect(str(snapshot))
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()

    await asyncio.to_thread(take_snapshot)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return FileResponse(
        path=snapshot,
        filename=f"{path.stem}-{stamp}.db",
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
        background=BackgroundTask(snapshot.unlink, missing_ok=True),
    )


class DatabaseResetRequest(BaseModel):
    confirm: str
    keep_categories: bool = False


@router.post("/system/database/reset", tags=["System"])
async def reset_database(req: DatabaseResetRequest, _admin: AdminKey, db: AsyncSession = Depends(get_db)):
    """Start over with an empty job database.

    Running jobs are cancelled. Client keys are kept so connected extensions
    keep working; files on disk are not touched.
    """
    if req.confirm != "RESET":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Send {"confirm": "RESET"} to confirm')

    JobWorkerQueue.cancel_all_active(purge=False)
    jobs = (await db.execute(select(func.count()).select_from(Job))).scalar_one()
    await db.execute(delete(JobSegment))
    await db.execute(delete(Job))
    if not req.keep_categories:
        await db.execute(delete(CategoryModel))
    await db.commit()

    if _sqlite_path():
        try:
            async with engine.connect() as conn:  # VACUUM cannot run inside a transaction
                await conn.execution_options(isolation_level="AUTOCOMMIT")
                await conn.execute(text("VACUUM"))
        except Exception:
            pass  # reclaiming space is best-effort

    return {"ok": True, "deleted_jobs": jobs, "categories_kept": req.keep_categories}
