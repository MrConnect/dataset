import sys
import asyncio
from contextlib import asynccontextmanager

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import router
from app.config import settings
from app.db.session import init_db
from app.workers.queue import JobWorkerQueue


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: ensure DB tables and start worker queue
    await init_db()
    if not settings.CELERY_ENABLED:
        await JobWorkerQueue.start(settings.CONCURRENT_WORKERS)
    yield
    # Shutdown: stop worker queue
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


@app.get("/")
async def root():
    return {
        "service": "Universal Video Segment Tagger API",
        "version": "1.0.0",
        "status": "online",
        "docs": "/docs",
    }
