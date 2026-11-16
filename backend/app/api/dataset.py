"""Dataset library: listing, serving, moving and deleting stored files.

Every route requires authentication. Mutating routes need the ``X-API-Key``
header; file GET routes additionally accept the media session cookie so the
dashboard can use plain ``<video src>`` and download links.

The SQLite database is intentionally *not* part of the library. It is managed
separately under ``/api/v1/system/database`` (admin only).
"""

import asyncio
import os
import shutil
import time
import zipfile
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import Principal, verify_api_key, verify_media_access
from app.db.session import get_db
from app.models.job import CategoryModel
from app.services import thumbnails
from app.services.source_intake import ALLOWED_VIDEO_SUFFIXES

router = APIRouter()

ApiKeyAuth = Annotated[Principal, Depends(verify_api_key)]
MediaAuth = Annotated[Principal, Depends(verify_media_access)]

# Virtual categories that map to storage outside DATASET_DIR.
DOWNLOADS_CATEGORY = "_downloads"
TEMP_CATEGORY = "_temp"
RESERVED_CATEGORIES = {"_database", "_system", "metadata"}

# Only these are rendered inline by the browser; anything else is forced to
# download so an uploaded file can never run as a page on this origin.
INLINE_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".ts": "video/mp2t",
    ".avi": "video/x-msvideo",
}


class MoveVideoRequest(BaseModel):
    old_category: str
    old_filename: str
    new_category: str
    new_filename: str

class DatasetFileRef(BaseModel):
    category: str
    filename: str

class BulkFileRequest(BaseModel):
    files: list[DatasetFileRef]

class BulkMoveRequest(BulkFileRequest):
    new_category: str


def get_dataset_dir() -> Path:
    d = Path(settings.DATASET_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d

def get_temp_dir() -> Path:
    d = Path(settings.TEMP_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d

def get_downloads_dir() -> Path:
    d = Path(settings.BASE_STORAGE_DIR) / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    return d

def validate_path_component(value: str, field: str) -> str:
    """Allow one filename/path component only; never let dashboard input escape storage."""
    if (
        not value
        or value in {".", ".."}
        or Path(value).name != value
        or "/" in value
        or "\\" in value
        or "\x00" in value
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid {field}")
    return value

def ensure_mutable_category(category: str) -> None:
    if category in RESERVED_CATEGORIES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="System files cannot be modified here")

def get_target_path(category: str, filename: str = "", *, create: bool = False) -> Path:
    category = validate_path_component(category, "category")
    ensure_mutable_category(category)
    if filename:
        filename = validate_path_component(filename, "filename")
    if category == DOWNLOADS_CATEGORY:
        d = get_downloads_dir()
    elif category == TEMP_CATEGORY:
        d = get_temp_dir()
    else:
        d = get_dataset_dir() / category
        if create:
            d.mkdir(parents=True, exist_ok=True)

    if filename:
        return d / filename
    return d

def file_url(category: str, filename: str) -> str:
    return f"/api/v1/dataset/file/{quote(category, safe='')}/{quote(filename, safe='')}"

def thumb_url(category: str, filename: str, version: float) -> str:
    return f"/api/v1/dataset/thumb/{quote(category, safe='')}/{quote(filename, safe='')}?v={int(version)}"

def _describe(category: str, file: Path) -> dict:
    stat = file.stat()
    has_thumb = category != TEMP_CATEGORY and thumbnails.can_thumbnail(file.name)
    thumb_ready = has_thumb and thumbnails.is_ready(category, file.name, file)
    return {
        "filename": file.name,
        "size": stat.st_size,
        "created_at": stat.st_ctime,
        "modified_at": stat.st_mtime,
        "url": file_url(category, file.name),
        # The version changes when the file is replaced, so browsers never
        # show a cached image of different content.
        "thumb": thumb_url(category, file.name, stat.st_mtime) if has_thumb else None,
        "thumb_ready": thumb_ready,
    }

def source_dir_for(category: str) -> Path | None:
    """Directory that holds a category's files (used to sweep orphaned thumbnails)."""
    directory = thumbnails.source_dir(category)
    return directory if directory is not None and directory.is_dir() else None

def _prune_if_empty(category: str) -> None:
    """Remove a dataset category folder that a move or delete left empty."""
    if category.startswith("_"):
        return
    directory = get_dataset_dir() / category
    try:
        if directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
    except OSError:
        pass

def _list_files(category: str, directory: Path, pattern: str = "*") -> list[dict]:
    if not directory.is_dir():
        return []
    items = []
    for file in directory.glob(pattern):
        try:
            if file.is_file():
                items.append(_describe(category, file))
        except OSError:
            continue  # removed while listing
    return sorted(items, key=lambda x: x["created_at"], reverse=True)


@router.post("/upload_video")
async def upload_video(_auth: ApiKeyAuth, file: UploadFile = File(...)):
    """Single-request library upload (small files). Browsers use /api/v1/uploads."""
    downloads_dir = get_downloads_dir()

    filename = validate_path_component(file.filename or "", "filename")
    if Path(filename).suffix.lower() not in ALLOWED_VIDEO_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Unsupported video file type")
    file_path = downloads_dir / filename
    if file_path.exists():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A file with this name already exists")
    written = 0
    try:
        with file_path.open("wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > settings.MAX_DOWNLOAD_SIZE_BYTES:
                    raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Uploaded file is too large")
                buffer.write(chunk)
    except Exception:
        file_path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    thumbnails.ThumbnailWorker.schedule(DOWNLOADS_CATEGORY, filename)
    return {"ok": True, "filename": filename, "size": written, "url": file_url(DOWNLOADS_CATEGORY, filename)}


@router.get("/")
async def list_dataset(_auth: ApiKeyAuth, db: AsyncSession = Depends(get_db)):
    dataset_dir = get_dataset_dir()
    categories = []

    # Map DB category IDs to their real names
    db_res = await db.execute(select(CategoryModel))
    db_categories = {c.id: c.name for c in db_res.scalars().all()}

    # 1. Standard Dataset Categories
    for cat_dir in dataset_dir.iterdir():
        if cat_dir.is_dir() and cat_dir.name != "metadata" and not cat_dir.name.startswith("_"):
            raw_name = cat_dir.name
            categories.append({
                "name": raw_name,
                "display_name": db_categories.get(raw_name) or raw_name.replace("_", " ").title(),
                "videos": _list_files(raw_name, cat_dir, "*.mp4"),
            })

    # 2. Full source videos (server downloads and uploads)
    categories.append({
        "name": DOWNLOADS_CATEGORY,
        "display_name": "Source Downloads",
        "videos": _list_files(DOWNLOADS_CATEGORY, get_downloads_dir()),
    })

    # 3. Temporary processing files
    categories.append({
        "name": TEMP_CATEGORY,
        "display_name": "Temporary Files",
        "videos": _list_files(TEMP_CATEGORY, get_temp_dir()),
    })

    return {"categories": categories}


@router.get("/file/{category}/{filename}")
async def get_file(category: str, filename: str, _auth: MediaAuth):
    """Serve one stored file (supports Range requests for seeking)."""
    file_path = get_target_path(category, filename)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    media_type = INLINE_MEDIA_TYPES.get(file_path.suffix.lower())
    return FileResponse(
        path=file_path,
        media_type=media_type or "application/octet-stream",
        filename=file_path.name,
        content_disposition_type="inline" if media_type else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"},
    )


@router.get("/thumb/{category}/{filename}")
async def get_thumbnail(category: str, filename: str, _auth: MediaAuth):
    """Small JPEG preview, generated on first request and cached on disk."""
    file_path = get_target_path(category, filename)
    if category == TEMP_CATEGORY or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    cached = await thumbnails.ensure_thumbnail(category, filename, file_path)
    if cached is None:
        raise HTTPException(status_code=404, detail="No thumbnail available", headers={"Cache-Control": "no-store"})
    return FileResponse(
        path=cached,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


class CategoryCreateRequest(BaseModel):
    name: str


@router.post("/category", status_code=status.HTTP_201_CREATED)
async def create_category(req: CategoryCreateRequest, _auth: ApiKeyAuth):
    name = validate_path_component(req.name.strip(), "category")
    if name.startswith("_") or name in RESERVED_CATEGORIES or len(name) > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid category name")
    directory = get_dataset_dir() / name
    if directory.exists():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Category already exists")
    directory.mkdir(parents=True)
    return {"name": name}


@router.post("/bulk/delete")
async def delete_videos(req: BulkFileRequest, _auth: ApiKeyAuth):
    if not req.files:
        raise HTTPException(status_code=400, detail="No files selected")
    paths = [get_target_path(item.category, item.filename) for item in req.files]
    missing = [path.name for path in paths if not path.exists()]
    if missing:
        raise HTTPException(status_code=404, detail=f"Files not found: {', '.join(missing[:3])}")

    def remove_all():
        for item, path in zip(req.files, paths):
            path.unlink()
            thumbnails.remove_thumbnail(item.category, item.filename)
        for category in {item.category for item in req.files}:
            _prune_if_empty(category)

    await asyncio.to_thread(remove_all)
    return {"status": "deleted", "count": len(paths)}

@router.post("/bulk/move")
async def move_videos(req: BulkMoveRequest, _auth: ApiKeyAuth):
    if not req.files:
        raise HTTPException(status_code=400, detail="No files selected")
    destination = validate_path_component(req.new_category, "category")
    moves: list[tuple[DatasetFileRef, Path, Path]] = []
    for item in req.files:
        old_path = get_target_path(item.category, item.filename)
        new_path = get_target_path(destination, item.filename, create=True)
        if not old_path.exists():
            raise HTTPException(status_code=404, detail=f"Source file not found: {item.filename}")
        if old_path != new_path and new_path.exists():
            raise HTTPException(status_code=409, detail=f"Target already exists: {item.filename}")
        if old_path != new_path:
            moves.append((item, old_path, new_path))

    scheduled: list[tuple[str, str]] = []

    def move_all():
        for item, old_path, new_path in moves:
            shutil.move(str(old_path), str(new_path))
            thumbnails.move_thumbnail(item.category, item.filename, destination, item.filename)
            scheduled.append((destination, item.filename))
        for category in {item.category for item, _, _ in moves}:
            _prune_if_empty(category)

    await asyncio.to_thread(move_all)
    for category, filename in scheduled:
        if not thumbnails.is_ready(category, filename, get_target_path(category, filename)):
            thumbnails.ThumbnailWorker.schedule(category, filename)
    return {"status": "moved", "count": len(moves), "category": destination}

@router.delete("/{category}/{filename}")
async def delete_video(category: str, filename: str, _auth: ApiKeyAuth):
    file_path = get_target_path(category, filename)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    def remove():
        file_path.unlink()
        thumbnails.remove_thumbnail(category, filename)
        _prune_if_empty(category)

    await asyncio.to_thread(remove)
    return {"status": "deleted"}

@router.post("/move")
async def move_video(req: MoveVideoRequest, _auth: ApiKeyAuth):
    old_path = get_target_path(req.old_category, req.old_filename)
    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")

    new_path = get_target_path(req.new_category, req.new_filename, create=True)
    if new_path != old_path and new_path.exists():
        raise HTTPException(status_code=409, detail="A file with this name already exists there")

    def move():
        shutil.move(str(old_path), str(new_path))
        thumbnails.move_thumbnail(req.old_category, req.old_filename, req.new_category, req.new_filename)
        _prune_if_empty(req.old_category)

    if old_path != new_path:
        await asyncio.to_thread(move)
        if not thumbnails.is_ready(req.new_category, req.new_filename, new_path):
            thumbnails.ThumbnailWorker.schedule(req.new_category, req.new_filename)
    return {"status": "moved", "category": req.new_category, "filename": req.new_filename}

@router.get("/download_folder/{category}")
async def download_folder_zip(category: str, _auth: MediaAuth):
    category = validate_path_component(category, "category")
    ensure_mutable_category(category)
    dataset_dir = get_dataset_dir()
    cat_dir = dataset_dir / category
    if category.startswith("_") or not cat_dir.exists() or not cat_dir.is_dir():
        raise HTTPException(status_code=404, detail="Category not found")

    temp_dir = get_temp_dir()
    zip_filename = f"{category}_{int(time.time())}.zip"
    zip_path = temp_dir / zip_filename

    # Run zip creation in a separate thread so we don't block
    def create_zip():
        # Clips are already compressed video; storing avoids burning CPU for ~0% gain.
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zipf:
            for root, _, files in os.walk(cat_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, start=cat_dir)
                    zipf.write(file_path, arcname)

    await asyncio.to_thread(create_zip)

    return FileResponse(
        path=zip_path,
        filename=f"{category}.zip",
        media_type="application/zip",
        headers={"Cache-Control": "private, max-age=345600"},
    )
