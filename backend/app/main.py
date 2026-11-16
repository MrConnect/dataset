import sys
import asyncio
from contextlib import asynccontextmanager

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import logging
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.admin import router as admin_router
from app.api.dataset import router as dataset_router, source_dir_for
from app.api.routes import router
from app.api.uploads import router as uploads_router
from app.config import settings
from app.core.security import get_admin_key
from app.db.session import init_db
from app.services import thumbnails
from app.services.upload_sessions import cleanup_stale_sessions
from app.workers.queue import JobWorkerQueue

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

ZIP_MAX_AGE_SECONDS = 96 * 3600


async def periodic_cleanup():
    """Hourly: drop old zip exports and abandoned chunked uploads."""
    while True:
        try:
            temp_dir = Path(settings.TEMP_DIR)
            if temp_dir.exists():
                now = time.time()
                for file in temp_dir.glob("*.zip"):
                    if now - file.stat().st_ctime > ZIP_MAX_AGE_SECONDS:
                        file.unlink()
                for file in temp_dir.glob("db_snapshot_*.db"):
                    if now - file.stat().st_ctime > 3600:
                        file.unlink()
            cleanup_stale_sessions()
            await asyncio.to_thread(thumbnails.sweep_orphans, source_dir_for)
            # Rebuild any thumbnail that went missing (or was never made, e.g.
            # clips cut by a Celery worker, which has no renderer).
            await thumbnails.ThumbnailWorker.backfill()
        except Exception:
            logging.getLogger("cleanup").warning("Cleanup pass failed", exc_info=True)
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: ensure DB tables, make sure an admin key exists, start workers.
    # The workers re-queue any job that was interrupted by the last shutdown.
    await init_db()
    get_admin_key()
    if not settings.CELERY_ENABLED:
        await JobWorkerQueue.start(settings.CONCURRENT_WORKERS)

    thumbnails.ThumbnailWorker.start()
    cleanup_task = asyncio.create_task(periodic_cleanup())

    yield

    cleanup_task.cancel()
    if not settings.CELERY_ENABLED:
        await JobWorkerQueue.stop()
    await thumbnails.ThumbnailWorker.stop()


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
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith("/dashboard"):
        response.headers.setdefault("X-Frame-Options", "DENY")
        # Always revalidate (ETag) so a browser never runs an old script
        # against a new page after an update.
        response.headers["Cache-Control"] = "no-cache"
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        )
    return response

app.include_router(router)
app.include_router(dataset_router, prefix="/api/v1/dataset", tags=["Dataset"])
app.include_router(uploads_router)
app.include_router(admin_router)

# Ensure directories exist
Path(settings.DATASET_DIR).mkdir(parents=True, exist_ok=True)
static_dir = Path(__file__).parent.parent / "static"
static_dir.mkdir(parents=True, exist_ok=True)

# Stored files are served only through the authenticated
# /api/v1/dataset/file route; storage is never mounted as static files.
Path(settings.BASE_STORAGE_DIR).mkdir(parents=True, exist_ok=True)
# Mount dashboard
app.mount("/dashboard", StaticFiles(directory=str(static_dir), html=True), name="dashboard")


@app.get("/")
async def root():
    return {
        "service": "Universal Video Segment Tagger API",
        "dashboard": "/dashboard/index.html",
        "docs": "/docs",
    }
