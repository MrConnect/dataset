import sys
import asyncio
from contextlib import asynccontextmanager

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import time
from app.api.routes import router
from app.api.dataset import router as dataset_router
from app.config import settings
from app.db.session import init_db
from app.workers.queue import JobWorkerQueue

async def cleanup_old_zips():
    """Delete zip files older than 96 hours from TEMP_DIR."""
    while True:
        try:
            temp_dir = Path(settings.TEMP_DIR)
            if temp_dir.exists():
                now = time.time()
                for file in temp_dir.glob("*.zip"):
                    # 96 hours = 345600 seconds
                    if now - file.stat().st_ctime > 345600:
                        file.unlink()
        except Exception:
            pass
        await asyncio.sleep(3600) # Check every hour

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: ensure DB tables and start worker queue
    await init_db()
    if not settings.CELERY_ENABLED:
        await JobWorkerQueue.start(settings.CONCURRENT_WORKERS)
    
    # Start cleanup task
    cleanup_task = asyncio.create_task(cleanup_old_zips())
    
    yield
    # Shutdown: stop worker queue
    cleanup_task.cancel()
    if not settings.CELERY_ENABLED:
        await JobWorkerQueue.stop()


app = FastAPI(
    title="Universal Video Segment Tagger API",
    version="1.0.0",
    description="Backend processing pipeline for collecting, classifying, and preparing video segments for CVAT datasets.",
    lifespan=lifespan,
)

# Enable CORS for Microsoft Edge / Chromium extensions and local web clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(dataset_router, prefix="/api/v1/dataset", tags=["Dataset"])

# Ensure directories exist
Path(settings.DATASET_DIR).mkdir(parents=True, exist_ok=True)
static_dir = Path(__file__).parent.parent / "static"
static_dir.mkdir(parents=True, exist_ok=True)

# Mount dataset for direct preview (e.g. /media/category/file.mp4)
app.mount("/media", StaticFiles(directory=settings.DATASET_DIR), name="media")
# Mount dashboard
app.mount("/dashboard", StaticFiles(directory=str(static_dir), html=True), name="dashboard")


@app.get("/")
async def root():
    return {
        "service": "Universal Video Segment Tagger API",
        "dashboard": "/dashboard/index.html",
        "docs": "/docs",
    }
