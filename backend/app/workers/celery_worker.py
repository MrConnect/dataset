import asyncio
from celery import Celery
from app.config import settings

celery_app = Celery(
    "video_tagger_worker",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    worker_concurrency=settings.CONCURRENT_WORKERS,
)


@celery_app.task(name="process_video_job")
def process_video_job(job_id: str) -> str:
    """
    Celery task wrapper delegating to the async pipeline.
    """
    from app.workers.queue import JobWorkerQueue
    asyncio.run(JobWorkerQueue._process_job(job_id))
    return job_id
