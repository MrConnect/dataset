import os
import shutil
import time
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import zipfile
import asyncio

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.session import get_db
from app.models.job import CategoryModel
from app.config import settings

router = APIRouter()

@router.post("/upload_video")
async def upload_video(file: UploadFile = File(...)):
    downloads_dir = Path(settings.BASE_STORAGE_DIR) / "downloads"
    downloads_dir.mkdir(parents=True, exist_ok=True)
    
    filename = validate_path_component(file.filename or "", "filename")
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
        
    return {"ok": True, "filename": filename, "size": written}

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

def validate_path_component(value: str, field: str) -> str:
    """Allow one filename/path component only; never let dashboard input escape storage."""
    if not value or value in {".", ".."} or Path(value).name != value or "/" in value or "\\" in value:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid {field}")
    return value

def get_target_path(category: str, filename: str = "") -> Path:
    category = validate_path_component(category, "category")
    if filename:
        filename = validate_path_component(filename, "filename")
    if category == "_downloads":
        d = Path(settings.BASE_STORAGE_DIR) / "downloads"
    elif category == "_temp":
        d = get_temp_dir()
    elif category == "_database":
        d = Path(settings.BASE_STORAGE_DIR)
    else:
        d = get_dataset_dir() / category
        d.mkdir(parents=True, exist_ok=True)
    
    if filename:
        return d / filename
    return d

def ensure_mutable_category(category: str) -> None:
    if category == "_database":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="System database cannot be modified")

@router.get("/")
async def list_dataset(db: AsyncSession = Depends(get_db)):
    dataset_dir = get_dataset_dir()
    categories = []
    
    # Map DB category IDs to their real names
    db_res = await db.execute(select(CategoryModel))
    db_categories = {c.id: c.name for c in db_res.scalars().all()}
    
    # 1. Standard Dataset Categories
    for cat_dir in dataset_dir.iterdir():
        if cat_dir.is_dir() and cat_dir.name != "metadata" and not cat_dir.name.startswith("_"):
            videos = []
            for video_file in cat_dir.glob("*.mp4"):
                videos.append({
                    "filename": video_file.name,
                    "size": video_file.stat().st_size,
                    "created_at": video_file.stat().st_ctime,
                    "url": f"/media/{cat_dir.name}/{video_file.name}"
                })
            
            # Format label name based on DB, fallback to formatted folder name
            raw_name = cat_dir.name
            display_name = db_categories.get(raw_name)
            if not display_name:
                display_name = raw_name.replace("_", " ").title()

            categories.append({
                "name": raw_name,
                "display_name": display_name,
                "videos": sorted(videos, key=lambda x: x["created_at"], reverse=True)
            })
            
    # 2. Full Downloads (Cache)
    downloads_dir = Path(settings.BASE_STORAGE_DIR) / "downloads"
    if downloads_dir.exists() and downloads_dir.is_dir():
        downloads = []
        for file in downloads_dir.iterdir():
            if file.is_file():
                downloads.append({
                    "filename": file.name,
                    "size": file.stat().st_size,
                    "created_at": file.stat().st_ctime,
                    "url": f"/storage/downloads/{file.name}"
                })
        categories.append({
            "name": "_downloads",
            "display_name": "Source Downloads",
            "videos": sorted(downloads, key=lambda x: x["created_at"], reverse=True)
        })

    # 3. Temporary processing files
    temp_dir = get_temp_dir()
    temporary_files = []
    for file in temp_dir.iterdir():
        if file.is_file():
            temporary_files.append({
                "filename": file.name,
                "size": file.stat().st_size,
                "created_at": file.stat().st_ctime,
                "url": f"/storage/temp/{file.name}"
            })
    categories.append({
        "name": "_temp",
        "display_name": "Temporary Files",
        "videos": sorted(temporary_files, key=lambda x: x["created_at"], reverse=True)
    })

    # 4. System Database
    db_path = Path(settings.BASE_STORAGE_DIR) / "tagger.db"
    if db_path.exists():
        categories.append({
            "name": "_database",
            "display_name": "System Database",
            "videos": [{
                "filename": db_path.name,
                "size": db_path.stat().st_size,
                "created_at": db_path.stat().st_ctime,
                "url": f"/storage/{db_path.name}"
            }]
        })
            
    return {"categories": categories}

@router.post("/bulk/delete")
async def delete_videos(req: BulkFileRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="No files selected")
    for item in req.files:
        ensure_mutable_category(item.category)
    paths = [get_target_path(item.category, item.filename) for item in req.files]
    missing = [path.name for path in paths if not path.exists()]
    if missing:
        raise HTTPException(status_code=404, detail=f"Files not found: {', '.join(missing[:3])}")

    def remove_all():
        for path in paths:
            path.unlink()

    await asyncio.to_thread(remove_all)
    return {"status": "deleted", "count": len(paths)}

@router.post("/bulk/move")
async def move_videos(req: BulkMoveRequest):
    if not req.files:
        raise HTTPException(status_code=400, detail="No files selected")
    destination = validate_path_component(req.new_category, "category")
    moves: list[tuple[Path, Path]] = []
    for item in req.files:
        ensure_mutable_category(item.category)
        old_path = get_target_path(item.category, item.filename)
        new_path = get_target_path(destination, item.filename)
        if not old_path.exists():
            raise HTTPException(status_code=404, detail=f"Source file not found: {item.filename}")
        if old_path != new_path and new_path.exists():
            raise HTTPException(status_code=409, detail=f"Target already exists: {item.filename}")
        if old_path != new_path:
            moves.append((old_path, new_path))

    def move_all():
        for old_path, new_path in moves:
            shutil.move(str(old_path), str(new_path))

    await asyncio.to_thread(move_all)
    return {"status": "moved", "count": len(moves), "category": destination}

@router.delete("/{category}/{filename}")
async def delete_video(category: str, filename: str):
    ensure_mutable_category(category)
    file_path = get_target_path(category, filename)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    # Prevent deleting active DB if possible, but let OS handle locks
    await asyncio.to_thread(file_path.unlink)
    return {"status": "deleted"}

@router.post("/move")
async def move_video(req: MoveVideoRequest):
    ensure_mutable_category(req.old_category)
    old_path = get_target_path(req.old_category, req.old_filename)
    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
        
    new_path = get_target_path(req.new_category, req.new_filename)
    if new_path.exists():
        raise HTTPException(status_code=400, detail="Target filename already exists")
        
    await asyncio.to_thread(shutil.move, str(old_path), str(new_path))
    return {"status": "moved"}

@router.get("/download_folder/{category}")
async def download_folder_zip(category: str):
    category = validate_path_component(category, "category")
    dataset_dir = get_dataset_dir()
    cat_dir = dataset_dir / category
    if not cat_dir.exists() or not cat_dir.is_dir():
        raise HTTPException(status_code=404, detail="Category not found")
        
    temp_dir = get_temp_dir()
    zip_filename = f"{category}_{int(time.time())}.zip"
    zip_path = temp_dir / zip_filename
    
    # Run zip creation in a separate thread so we don't block
    def create_zip():
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, files in os.walk(cat_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, start=cat_dir)
                    zipf.write(file_path, arcname)
                    
    await asyncio.to_thread(create_zip)
    
    # FileResponse automatically handles Range requests (resumable downloads)
    return FileResponse(
        path=zip_path, 
        filename=f"{category}.zip", 
        media_type="application/zip",
        headers={
            "Cache-Control": "public, max-age=345600", # 96 hours cache directive
            "Content-Disposition": f'attachment; filename="{category}.zip"'
        }
    )
