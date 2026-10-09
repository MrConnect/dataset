import shutil
import uuid
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import desc, select
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
from app.workers.queue import JobWorkerQueue

router = APIRouter(prefix="/api/v1")


@router.get("/health")
async def health_check():
    """
    Checks health of server, FFmpeg/FFprobe availability, and storage directories.
    """
    ffmpeg_available = bool(shutil.which("ffmpeg"))
    ffprobe_available = bool(shutil.which("ffprobe"))
    storage_writable = settings.dataset_path.exists() and settings.temp_path.exists()

    return {
        "status": "healthy" if (ffmpeg_available and ffprobe_available and storage_writable) else "degraded",
        "ffmpeg": "available" if ffmpeg_available else "missing",
        "ffprobe": "available" if ffprobe_available else "missing",
        "storage": "writable" if storage_writable else "unavailable",
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
            existing = await db.get(CategoryModel, cat.id)
            if not existing:
                db.add(
                    CategoryModel(
                        id=cat.id,
                        name=cat.name,
                        color=cat.color,
                        description=cat.description,
                        shortcut=cat.shortcut,
                    )
                )

    await db.commit()

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
        segments_count=len(segments),
        created_at=job.created_at,
        updated_at=job.updated_at,
        segments=[
            SegmentResult(
                id=s.segment_id,
                start_seconds=s.start_seconds,
                end_seconds=s.end_seconds,
                categories=s.categories,
                status=s.status,
                output_path=s.output_path,
                duration=s.duration,
                error=s.error,
            )
            for s in segments
        ],
    )


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
        results.append(
            JobDetailResponse(
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
                segments_count=len(segments),
                created_at=job.created_at,
                updated_at=job.updated_at,
                segments=[
                    SegmentResult(
                        id=s.segment_id,
                        start_seconds=s.start_seconds,
                        end_seconds=s.end_seconds,
                        categories=s.categories,
                        status=s.status,
                        output_path=s.output_path,
                        duration=s.duration,
                        error=s.error,
                    )
                    for s in segments
                ],
            )
        )
    return results


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
