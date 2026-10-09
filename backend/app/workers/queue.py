import asyncio
import logging
from pathlib import Path
from sqlalchemy import select, update
from app.config import settings
from app.db.session import AsyncSessionLocal
from app.models.job import Job, JobSegment
from app.services.downloader import VideoDownloader
from app.services.video_processor import VideoProcessor
from app.services.storage_manager import StorageManager

logger = logging.getLogger("worker")


class JobWorkerQueue:
    _queue: asyncio.Queue[str] = asyncio.Queue()
    _cancelled_jobs: set[str] = set()
    _workers: list[asyncio.Task] = []
    _running: bool = False

    @classmethod
    async def start(cls, num_workers: int = 2) -> None:
        cls._running = True
        for i in range(num_workers):
            task = asyncio.create_task(cls._worker_loop(i))
            cls._workers.append(task)
        logger.info(f"Started {num_workers} background job workers")

    @classmethod
    async def stop(cls) -> None:
        cls._running = False
        for task in cls._workers:
            task.cancel()
        cls._workers.clear()

    @classmethod
    async def enqueue_job(cls, job_id: str) -> None:
        await cls._queue.put(job_id)

    @classmethod
    def cancel_job(cls, job_id: str) -> None:
        cls._cancelled_jobs.add(job_id)

    @classmethod
    async def _worker_loop(cls, worker_id: int) -> None:
        while cls._running:
            try:
                job_id = await cls._queue.get()
                if job_id in cls._cancelled_jobs:
                    cls._cancelled_jobs.remove(job_id)
                    cls._queue.task_done()
                    continue

                await cls._process_job(job_id)
                cls._queue.task_done()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Worker {worker_id} unexpected error: {e}", exc_info=True)

    @classmethod
    async def _process_job(cls, job_id: str) -> None:
        source_path: Path | None = None
        errors: list[str] = []

        async with AsyncSessionLocal() as session:
            # Load Job
            job = await session.get(Job, job_id)
            if not job:
                return

            if job.id in cls._cancelled_jobs:
                job.status = "cancelled"
                await session.commit()
                return

            try:
                # 1. Transition to downloading
                job.status = "downloading"
                job.progress = 10
                await session.commit()

                headers = {"Referer": job.page_url} if job.page_url else {}

                target_url, resolved_type, req_headers = await VideoDownloader.resolve_stream(
                    media_url=job.media_url,
                    media_type=job.media_type,
                    variant_url=job.variant_url,
                    headers=headers,
                    target_height=job.quality_height,
                )

                is_stream = resolved_type in ("hls", "dash") or ".m3u8" in target_url or ".mpd" in target_url
                headers_to_use: dict[str, str] | None = None
                source_path: Path | str | None = None
                probed_duration: float | None = None

                if is_stream:
                    # Fast path: Extract segments directly from HLS/DASH stream chunks in seconds
                    source_path = target_url
                    headers_to_use = req_headers
                    logger.info(f"Job {job.id} using direct stream extraction from {target_url[:80]}...")
                else:
                    # Static file download path
                    source_path, probed_duration = await VideoDownloader.download_source(
                        job_id=job.id,
                        media_url=target_url,
                        media_type=resolved_type,
                        headers=req_headers,
                    )

                if probed_duration and not job.duration_seconds:
                    job.duration_seconds = probed_duration

                if job.id in cls._cancelled_jobs:
                    job.status = "cancelled"
                    await session.commit()
                    return

                # 2. Transition to processing segments
                job.status = "processing"
                job.progress = 30
                await session.commit()

                # Fetch segments
                res = await session.execute(
                    select(JobSegment).where(JobSegment.job_id == job.id)
                )
                segments = res.scalars().all()

                segment_records = []
                success_count = 0

                total_segments = len(segments)
                for idx, seg in enumerate(segments):
                    if job.id in cls._cancelled_jobs:
                        job.status = "cancelled"
                        await session.commit()
                        return

                    temp_cut_out = settings.temp_path / f"{job.id}_{seg.segment_id}_cut.mp4"

                    try:
                        actual_dur = await VideoProcessor.extract_segment(
                            source_path=source_path,
                            output_path=temp_cut_out,
                            start_seconds=seg.start_seconds,
                            end_seconds=seg.end_seconds,
                            total_duration=job.duration_seconds or probed_duration,
                            headers=headers_to_use,
                        )

                        stored_files = StorageManager.store_segment_files(
                            job_id=job.id,
                            segment_id=seg.segment_id,
                            temp_segment_path=temp_cut_out,
                            category_ids=seg.categories,
                        )

                        seg.status = "completed"
                        seg.duration = actual_dur
                        seg.output_path = stored_files[0] if stored_files else None
                        success_count += 1

                        segment_records.append({
                            "segment_id": seg.segment_id,
                            "start_seconds": seg.start_seconds,
                            "end_seconds": seg.end_seconds,
                            "actual_duration": actual_dur,
                            "categories": seg.categories,
                            "output_files": stored_files,
                            "status": "completed",
                        })
                    except Exception as seg_err:
                        err_str = f"Segment {seg.segment_id} failed: {seg_err}"
                        logger.error(err_str)
                        seg.status = "failed"
                        seg.error = str(seg_err)
                        errors.append(err_str)
                        segment_records.append({
                            "segment_id": seg.segment_id,
                            "start_seconds": seg.start_seconds,
                            "end_seconds": seg.end_seconds,
                            "categories": seg.categories,
                            "status": "failed",
                            "error": str(seg_err),
                        })

                    progress_pct = 30 + int(((idx + 1) / total_segments) * 65)
                    job.progress = min(95, progress_pct)
                    await session.commit()

                # 3. Generate traceable CVAT metadata JSON
                StorageManager.save_job_metadata(
                    job_id=job.id,
                    page_url=job.page_url,
                    media_url=job.media_url,
                    media_type=job.media_type,
                    quality={"height": job.quality_height, "representation_id": job.representation_id},
                    source_duration=job.duration_seconds or probed_duration,
                    segment_records=segment_records,
                    errors=errors,
                )

                # 4. Final status determination
                if success_count == total_segments and total_segments > 0:
                    job.status = "completed"
                elif success_count > 0:
                    job.status = "partially_completed"
                else:
                    job.status = "failed"

                job.progress = 100
                if errors:
                    job.error = "; ".join(errors)

                await session.commit()

            except Exception as e:
                logger.error(f"Job {job_id} processing failed: {e}", exc_info=True)
                job.status = "failed"
                job.error = str(e)
                job.progress = 100
                await session.commit()

            finally:
                # Cleanup downloaded source temp file if local Path
                if source_path and isinstance(source_path, Path) and source_path.exists():
                    try:
                        source_path.unlink(missing_ok=True)
                    except Exception:
                        pass
