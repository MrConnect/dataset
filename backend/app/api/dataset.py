import os
import shutil
import time
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import zipfile
import asyncio

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

@router.get("/")
async def list_dataset():
    dataset_dir = get_dataset_dir()
    categories = []
    
    for cat_dir in dataset_dir.iterdir():
        if cat_dir.is_dir() and cat_dir.name != "metadata":
            videos = []
            for video_file in cat_dir.glob("*.mp4"):
                videos.append({
                    "filename": video_file.name,
                    "size": video_file.stat().st_size,
                    "created_at": video_file.stat().st_ctime
                })
            categories.append({
                "name": cat_dir.name,
                "videos": sorted(videos, key=lambda x: x["created_at"], reverse=True)
            })
            
    return {"categories": categories}

@router.delete("/{category}/{filename}")
async def delete_video(category: str, filename: str):
    video_path = get_dataset_dir() / category / filename
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    
    video_path.unlink()
    return {"status": "deleted"}

@router.post("/move")
async def move_video(req: MoveVideoRequest):
    dataset_dir = get_dataset_dir()
    old_path = dataset_dir / req.old_category / req.old_filename
    
    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Source video not found")
        
    new_cat_dir = dataset_dir / req.new_category
    new_cat_dir.mkdir(exist_ok=True)
    
    new_path = new_cat_dir / req.new_filename
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
