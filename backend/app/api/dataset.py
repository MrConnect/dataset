import os
import shutil
import time
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
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

class MoveVideoRequest(BaseModel):
    old_category: str
    old_filename: str
    new_category: str
    new_filename: str

def get_dataset_dir() -> Path:
    d = Path(settings.DATASET_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d

def get_temp_dir() -> Path:
    d = Path(settings.TEMP_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d

def get_target_path(category: str, filename: str = "") -> Path:
    if category == "_downloads":
        d = Path(settings.BASE_STORAGE_DIR) / "downloads"
    elif category == "_database":
        d = Path(settings.BASE_STORAGE_DIR)
    else:
        d = get_dataset_dir() / category
        d.mkdir(parents=True, exist_ok=True)
    
    if filename:
        return d / filename
    return d

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
        if downloads:
            categories.append({
                "name": "_downloads",
                "display_name": "System Downloads",
                "videos": sorted(downloads, key=lambda x: x["created_at"], reverse=True)
            })

    # 3. System Database
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

@router.delete("/{category}/{filename}")
async def delete_video(category: str, filename: str):
    file_path = get_target_path(category, filename)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    # Prevent deleting active DB if possible, but let OS handle locks
    file_path.unlink()
    return {"status": "deleted"}

@router.post("/move")
async def move_video(req: MoveVideoRequest):
    old_path = get_target_path(req.old_category, req.old_filename)
    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
        
    new_path = get_target_path(req.new_category, req.new_filename)
    if new_path.exists():
        raise HTTPException(status_code=400, detail="Target filename already exists")
        
    shutil.move(str(old_path), str(new_path))
    return {"status": "moved"}

@router.get("/download_folder/{category}")
async def download_folder_zip(category: str):
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
