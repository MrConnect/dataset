import asyncio
import logging
import shutil
from pathlib import Path
from sqlalchemy import select, update
from app.config import settings
from app.db.session import AsyncSessionLocal
from app.models.job import Job, JobSegment
from app.services.downloader import VideoDownloader
from app.services.video_processor import VideoProcessor
from app.services.storage_manager import StorageManager
from app.services.download_errors import classify_download_error

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
        source_should_persist = False
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

                headers = dict(job.source_headers or {})
                if job.page_url and not any(key.lower() == "referer" for key in headers):
                    headers["Referer"] = job.page_url

                async def on_download_progress(pct: int):
                    job.progress = min(100, pct)
                    await session.commit()
                
                if job.source_file_path:
                    source_path = Path(job.source_file_path)
                    source_should_persist = True
                    if not source_path.exists():
                        raise FileNotFoundError("Uploaded source file is missing. Upload it again to resume the job.")
                    probed_duration = await VideoDownloader._probe_media(source_path)
                    headers_to_use = {}
                elif job.acquisition_mode == "upload":
                    job.status = "awaiting_source"
                    job.failure_code = "SOURCE_UPLOAD_REQUIRED"
                    job.error = "Upload the source video to continue this job."
                    job.progress = 0
                    await session.commit()
                    return
                else:
                    target_url, resolved_type, req_headers = await VideoDownloader.resolve_stream(
                        media_url=job.media_url,
                        media_type=job.media_type,
                        variant_url=job.variant_url,
                        headers=headers,
                        target_height=job.quality_height,
                    )
                    logger.info(f"Job {job.id} downloading source video from {target_url[:80]}...")
                    try:
                        source_path, probed_duration = await VideoDownloader.download_source(
                            job_id=job.id,
                            media_url=target_url,
                            media_type=resolved_type,
                            headers=req_headers,
                            duration_seconds=job.duration_seconds,
                            progress_callback=on_download_progress,
                            target_height=job.quality_height,
                        )
                    except Exception as source_error:
                        failure = classify_download_error(source_error)
                        if failure.source_required:
                            job.status = "awaiting_source"
                            job.failure_code = failure.code
                            job.error = str(failure)
                            job.progress = 0
                            await session.commit()
                            return
                        raise failure from source_error
                    headers_to_use = req_headers

                if settings.KEEP_DOWNLOADED_SOURCES and source_path and not source_should_persist:
                    downloads_dir = Path(settings.BASE_STORAGE_DIR) / "downloads"
                    downloads_dir.mkdir(parents=True, exist_ok=True)
                    archived_source = downloads_dir / f"{job.id}_source{source_path.suffix or '.mp4'}"
                    archived_source.unlink(missing_ok=True)
                    await asyncio.to_thread(shutil.move, str(source_path), str(archived_source))
                    source_path = archived_source
                    source_should_persist = True
                    job.source_file_path = str(source_path)
                    await session.commit()

                expected_duration = job.duration_seconds
                job.duration_seconds = probed_duration
                # We completely removed the strict duration check here because streaming sites often report wildly inaccurate durations compared to the raw M3U8 payload.
                
                job.failure_code = None
                job.error = None

                if job.id in cls._cancelled_jobs:
                    job.status = "cancelled"
                    await session.commit()
                    return

                # 2. Transition to processing segments
                job.status = "processing"
                job.progress = 0
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

                    progress_pct = int(((idx + 1) / total_segments) * 100)
                    job.progress = min(100, progress_pct)
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
                failure = classify_download_error(e)
                job.status = "awaiting_source" if failure.source_required else "failed"
                job.failure_code = failure.code
                job.error = str(failure)
                job.progress = 0 if failure.source_required else 100
                await session.commit()

            finally:
                # Cleanup downloaded source temp file if local Path
                if source_path and not source_should_persist and isinstance(source_path, Path) and source_path.exists():
                    try:
                        # source_path.unlink(missing_ok=True)
                        print(f"Skipping deletion of {source_path} for debugging purposes.")
                    except Exception:
                        pass
