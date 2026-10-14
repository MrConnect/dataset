import shutil
import os
from pathlib import Path
import uuid
from typing import Annotated
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import desc, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import verify_api_key
from app.db.session import get_db
from app.models.job import CategoryModel, Job, JobSegment
from app.schemas.category import CategorySchema
from app.schemas.job import (
    JobDetailResponse,
    JobPayload,
    JobSubmitResponse,
    SegmentResult,
)
from app.schemas.source import SourceResolveRequest, SourceResolveResponse
from app.services.source_resolver import BackendSourceResolver
from app.services.storage_manager import StorageManager
from app.workers.queue import JobWorkerQueue

router = APIRouter(prefix="/api/v1")


def _job_response(job: Job, segments: list[JobSegment]) -> JobDetailResponse:
    return JobDetailResponse(
        job_id=job.id,
        schema_version=job.schema_version,
        status=job.status,
        page_url=job.page_url,
        media_url=job.media_url,
        media_type=job.media_type,
        quality_height=job.quality_height,
        duration_seconds=job.duration_seconds,
        progress=job.progress,
        error=job.error,
        failure_code=job.failure_code,
        acquisition_mode=job.acquisition_mode,
        source_required=job.status == "awaiting_source",
        segments_count=len(segments),
        created_at=job.created_at,
        updated_at=job.updated_at,
        segments=[
            SegmentResult(
                id=segment.segment_id,
                start_seconds=segment.start_seconds,
                end_seconds=segment.end_seconds,
                categories=segment.categories,
                status=segment.status,
                output_path=segment.output_path,
                duration=segment.duration,
                error=segment.error,
            )
            for segment in segments
        ],
    )


@router.get("/health")
async def health_check():
    """
    Checks health of server, FFmpeg/FFprobe availability, and storage directories.
    """
    ffmpeg_available = bool(shutil.which("ffmpeg"))
    ffprobe_available = bool(shutil.which("ffprobe"))
    storage_writable = all(os.access(path, os.W_OK) for path in (settings.dataset_path, settings.temp_path))
    database_writable = True
    if settings.DATABASE_URL.startswith("sqlite"):
        database_value = settings.DATABASE_URL.split("///", 1)[-1]
        database_path = Path(database_value)
        database_writable = database_path.exists() and os.access(database_path, os.W_OK) and os.access(database_path.parent, os.W_OK)

    return {
        "status": "healthy" if (ffmpeg_available and ffprobe_available and storage_writable and database_writable) else "degraded",
        "ffmpeg": "available" if ffmpeg_available else "missing",
        "ffprobe": "available" if ffprobe_available else "missing",
        "storage": "writable" if storage_writable else "unavailable",
        "database": "writable" if database_writable else "unavailable",
        "accurate_cutting": settings.ACCURATE_CUTTING,
        "celery_enabled": settings.CELERY_ENABLED,
    }


@router.post("/sources/resolve", response_model=SourceResolveResponse)
async def resolve_source(
    req: SourceResolveRequest,
    _auth: Annotated[str, Depends(verify_api_key)],
):
    """
    Validates source URL against SSRF policy and probes streams/qualities.
    """
    try:
        res = await BackendSourceResolver.resolve(
            media_url=req.media_url,
            type_hint=req.type,
            page_url=req.page_url,
            headers=req.headers,
        )
        return res
    except ValueError as val_err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(val_err))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Source probe error: {e}")


@router.post(
    "/jobs",
    response_model=JobSubmitResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_job(
    payload: JobPayload,
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    """
    Submits a video processing job. Returns HTTP 202 Accepted.
    """
    if len(payload.segments) > settings.MAX_SEGMENTS_PER_JOB:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Exceeded max allowed segments per job ({settings.MAX_SEGMENTS_PER_JOB})",
        )

    job_id = f"job_{uuid.uuid4().hex[:12]}"

    # Read category state before adding pending rows. This prevents a lookup from
    # triggering an early autoflush and gives database failures one clear path.
    existing_categories: dict[str, CategoryModel] = {}
    if payload.categories_metadata:
        ids = [category.id for category in payload.categories_metadata]
        existing_res = await db.execute(select(CategoryModel).where(CategoryModel.id.in_(ids)))
        existing_categories = {category.id: category for category in existing_res.scalars().all()}

    job = Job(
        id=job_id,
        schema_version=payload.schema_version,
        status="queued",
        page_url=payload.source.page_url,
        media_url=payload.source.media_url,
        media_type=payload.source.type,
        quality_height=payload.quality.height,
        representation_id=payload.quality.representation_id,
        variant_url=payload.quality.variant_url,
        source_headers=payload.source.headers,
        acquisition_mode="server" if payload.source.acquisition_mode == "auto" else payload.source.acquisition_mode,
        duration_seconds=payload.source.duration_seconds,
        progress=0,
    )
    db.add(job)

    # Save segments
    for seg_data in payload.segments:
        segment = JobSegment(
            job_id=job_id,
            segment_id=seg_data.id,
            start_seconds=seg_data.start_seconds,
            end_seconds=seg_data.end_seconds,
            categories=seg_data.categories,
            status="pending",
        )
        db.add(segment)

    # Sync categories metadata if provided
    if payload.categories_metadata:
        for cat in payload.categories_metadata:
            existing = existing_categories.get(cat.id)
            if existing:
                existing.name = cat.name
                existing.color = cat.color
                existing.description = cat.description
                existing.shortcut = cat.shortcut
            else:
                db.add(
                    CategoryModel(
                        id=cat.id,
                        name=cat.name,
                        color=cat.color,
                        description=cat.description,
                        shortcut=cat.shortcut,
                    )
                )

    try:
        await db.commit()
    except OperationalError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Job database is temporarily unavailable. Please retry after checking server storage.",
        ) from exc

    # Enqueue to background worker
    if settings.CELERY_ENABLED:
        from app.workers.celery_worker import process_video_job
        process_video_job.delay(job_id)
    else:
        await JobWorkerQueue.enqueue_job(job_id)

    return JobSubmitResponse(
        job_id=job_id,
        status="queued",
        segments_count=len(payload.segments),
        message="Job accepted for asynchronous processing",
    )


@router.get("/jobs/{job_id}", response_model=JobDetailResponse)
async def get_job(
    job_id: str,
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    """
    Returns full job details, progress, and segment results.
    """
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    res = await db.execute(select(JobSegment).where(JobSegment.job_id == job_id))
    segments = res.scalars().all()

    return _job_response(job, list(segments))


@router.get("/jobs", response_model=list[JobDetailResponse])
async def list_jobs(
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """
    Lists processing jobs with pagination and optional status filter.
    """
    query = select(Job).order_by(desc(Job.created_at)).offset(offset).limit(limit)
    if status_filter:
        query = query.where(Job.status == status_filter)

    res = await db.execute(query)
    jobs = res.scalars().all()

    results: list[JobDetailResponse] = []
    for job in jobs:
        seg_res = await db.execute(select(JobSegment).where(JobSegment.job_id == job.id))
        segments = seg_res.scalars().all()
        results.append(_job_response(job, list(segments)))
    return results


@router.post("/jobs/{job_id}/source", status_code=status.HTTP_202_ACCEPTED)
async def upload_job_source(
    job_id: str,
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
    file: UploadFile = File(...),
):
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.status in ("completed", "processing"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Job is already {job.status}")

    suffix = Path(file.filename or "source.mp4").suffix.lower()
    if suffix not in {".mp4", ".mkv", ".mov", ".webm", ".ts", ".m4v"}:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Unsupported video file type")

    for previous in settings.temp_path.glob(f"{job_id}_uploaded_source.*"):
        previous.unlink(missing_ok=True)
    destination = settings.temp_path / f"{job_id}_uploaded_source{suffix}"
    total = 0
    try:
        with destination.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > settings.MAX_DOWNLOAD_SIZE_BYTES:
                    raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Uploaded source is too large")
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    job.source_file_path = str(destination)
    job.acquisition_mode = "upload"
    job.status = "queued"
    job.progress = 0
    job.error = None
    job.failure_code = None
    await db.commit()
    if settings.CELERY_ENABLED:
        from app.workers.celery_worker import process_video_job
        process_video_job.delay(job.id)
    else:
        await JobWorkerQueue.enqueue_job(job.id)
    return {"job_id": job.id, "status": "queued", "message": "Source uploaded; processing resumed"}


@router.delete("/jobs/{job_id}")
async def delete_job(
    job_id: str,
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # The same endpoint is the full rollback operation for queued, active and
    # finished jobs. The worker performs another sweep in its finally block so
    # an in-flight FFmpeg process cannot recreate an artifact after this call.
    JobWorkerQueue.purge_job(job_id)
    cleanup = StorageManager.delete_job_files(job_id, job.source_file_path)
    await db.delete(job)
    await db.commit()
    return {"ok": True, "job_id": job_id, **cleanup}

@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    """
    Cancels an active or queued job.
    """
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    if job.status in ("completed", "failed", "cancelled"):
        return {"job_id": job.id, "status": job.status, "message": f"Job is already {job.status}"}

    job.status = "cancelled"
    await db.commit()

    JobWorkerQueue.cancel_job(job_id)
    return {"job_id": job.id, "status": "cancelled", "message": "Job cancelled successfully"}


@router.get("/categories", response_model=list[CategorySchema])
async def list_categories(
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    """
    Lists synced categories.
    """
    res = await db.execute(select(CategoryModel))
    categories = res.scalars().all()
    return [
        CategorySchema(
            id=c.id,
            name=c.name,
            color=c.color,
            description=c.description,
            shortcut=c.shortcut,
        )
        for c in categories
    ]


@router.post("/categories/sync", response_model=list[CategorySchema])
async def sync_categories(
    payload: list[CategorySchema],
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    """Merge browser categories into the shared server category registry."""
    if len(payload) > 500:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Too many categories")

    ids = [category.id for category in payload]
    existing: dict[str, CategoryModel] = {}
    if ids:
        res = await db.execute(select(CategoryModel).where(CategoryModel.id.in_(ids)))
        existing = {category.id: category for category in res.scalars().all()}

    for category in payload:
        current = existing.get(category.id)
        if current:
            current.name = category.name
            current.color = category.color
            current.description = category.description
            current.shortcut = category.shortcut
        else:
            db.add(CategoryModel(**category.model_dump()))

    await db.commit()
    return await list_categories(_auth, db)


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    category_id: str,
    _auth: Annotated[str, Depends(verify_api_key)],
    db: AsyncSession = Depends(get_db),
):
    """Remove a label from the shared registry without deleting produced clips."""
    category = await db.get(CategoryModel, category_id)
    if not category:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    await db.delete(category)
    await db.commit()
@router.get("/debug_error")
async def get_last_error():
    from app.db.models import Job, Segment
    from sqlalchemy import select
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Job).where(Job.status == 'failed').order_by(Job.created_at.desc())
        )
        job = result.scalars().first()
        if not job:
            return {"error": "No failed jobs found."}
        
        seg_res = await session.execute(
            select(Segment).where(Segment.job_id == job.id, Segment.status == 'failed')
        )
        segments = seg_res.scalars().all()
        seg_errors = {seg.segment_id: seg.error for seg in segments}

        return {
            "job_id": job.id,
            "job_error": job.error,
            "segment_errors": seg_errors
        }
