"""Job workers.

The ``jobs`` table is the queue: a row with ``status = 'queued'`` is waiting
for a worker. Workers claim rows with an atomic UPDATE, so nothing is held
only in memory and a restart loses no work — jobs that were mid-flight when
the process died are put back to ``queued`` on startup.

The only in-memory state is a pair of sets used to signal jobs that are
running *right now* in this process (cancel / purge).

A running job holds a lease: its worker refreshes ``updated_at`` every few
seconds. Only jobs whose lease has expired are taken back, so during a
rolling redeploy (old and new container sharing one database) the new
container never grabs a job the old one is still processing.
"""

import asyncio
import logging
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select, true, update

from app.config import settings
from app.db.session import AsyncSessionLocal
from app.models.job import Job, JobSegment
from app.services.download_errors import classify_download_error
from app.services.downloader import DownloadCancelled, VideoDownloader, remove_partial_downloads
from app.services.source_intake import find_library_source
from app.services.storage_manager import StorageManager
from app.services.thumbnails import ThumbnailWorker
from app.services.video_processor import VideoProcessor

logger = logging.getLogger("worker")

ACTIVE_STATUSES = ("downloading", "processing")


class JobCancelled(Exception):
    """Raised inside the pipeline when the running job was cancelled or deleted."""


def _utcnow() -> datetime:
    # Stored timestamps are naive UTC.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _format_seconds(seconds: float) -> str:
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


class JobWorkerQueue:
    POLL_INTERVAL_SECONDS = 5.0
    HEARTBEAT_SECONDS = 20.0
    LEASE_SECONDS = 120.0
    RECOVERY_INTERVAL_SECONDS = 60.0

    _wake: asyncio.Event | None = None
    _cancelled_jobs: set[str] = set()
    _purge_jobs: set[str] = set()
    _active_jobs: set[str] = set()
    _workers: list[asyncio.Task] = []
    _running: bool = False
    _last_recovery: float = 0.0

    # --- lifecycle ---------------------------------------------------------

    @classmethod
    async def start(cls, num_workers: int = 2) -> None:
        cls._wake = asyncio.Event()
        cls._running = True
        recovered = await cls.recover_interrupted_jobs()
        if recovered:
            logger.warning("Re-queued %d job(s) interrupted by a restart", recovered)
        for i in range(num_workers):
            cls._workers.append(asyncio.create_task(cls._worker_loop(i)))
        logger.info("Started %d background job workers", num_workers)

    @classmethod
    async def stop(cls) -> None:
        cls._running = False
        workers, cls._workers = cls._workers, []
        for task in workers:
            task.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        cls._wake = None

    @classmethod
    async def recover_interrupted_jobs(cls) -> int:
        """Re-queue running jobs whose worker stopped refreshing its lease.

        Covers a crash or restart without touching a job another live
        process (e.g. the old container during a redeploy) is still running.
        """
        cutoff = _utcnow() - timedelta(seconds=cls.LEASE_SECONDS)
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                update(Job)
                .where(Job.status.in_(ACTIVE_STATUSES), Job.updated_at < cutoff)
                .where(Job.id.not_in(list(cls._active_jobs)) if cls._active_jobs else true())
                .values(status="queued", progress=0, updated_at=_utcnow())
            )
            await session.commit()
            return result.rowcount or 0

    @classmethod
    async def _heartbeat(cls, job_id: str) -> None:
        while True:
            await asyncio.sleep(cls.HEARTBEAT_SECONDS)
            try:
                async with AsyncSessionLocal() as session:
                    await session.execute(
                        update(Job)
                        .where(Job.id == job_id, Job.status.in_(ACTIVE_STATUSES))
                        .values(updated_at=_utcnow())
                    )
                    await session.commit()
            except Exception:
                logger.debug("Heartbeat for %s failed", job_id, exc_info=True)

    # --- signalling --------------------------------------------------------

    @classmethod
    async def enqueue_job(cls, job_id: str) -> None:
        """Announce that ``job_id`` was written with status 'queued'."""
        cls._cancelled_jobs.discard(job_id)
        cls._purge_jobs.discard(job_id)
        if cls._wake is not None:
            cls._wake.set()

    @classmethod
    def cancel_job(cls, job_id: str) -> None:
        if job_id in cls._active_jobs:
            cls._cancelled_jobs.add(job_id)

    @classmethod
    def purge_job(cls, job_id: str) -> None:
        """Cancel a job and request a final artifact sweep by its worker."""
        if job_id in cls._active_jobs:
            cls._cancelled_jobs.add(job_id)
            cls._purge_jobs.add(job_id)

    @classmethod
    def cancel_all_active(cls, purge: bool = False) -> None:
        for job_id in list(cls._active_jobs):
            cls._cancelled_jobs.add(job_id)
            if purge:
                cls._purge_jobs.add(job_id)

    @classmethod
    def _is_cancelled(cls, job_id: str) -> bool:
        return job_id in cls._cancelled_jobs

    # --- worker loop -------------------------------------------------------

    @classmethod
    async def _claim_next_job(cls) -> str | None:
        """Atomically move the oldest queued job to 'downloading' and return its id."""
        async with AsyncSessionLocal() as session:
            for _ in range(5):
                candidate = (
                    await session.execute(
                        select(Job.id)
                        .where(Job.status == "queued")
                        .order_by(Job.created_at, Job.id)
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if candidate is None:
                    return None
                claimed = await session.execute(
                    update(Job)
                    .where(Job.id == candidate, Job.status == "queued")
                    .values(status="downloading", progress=0, updated_at=_utcnow())
                )
                await session.commit()
                if claimed.rowcount == 1:
                    return candidate
                # Another worker won the race; try the next row.
        return None

    @classmethod
    async def _worker_loop(cls, worker_id: int) -> None:
        while cls._running:
            try:
                wake = cls._wake
                if wake is not None:
                    wake.clear()
                loop_time = asyncio.get_running_loop().time()
                if worker_id == 0 and loop_time - cls._last_recovery > cls.RECOVERY_INTERVAL_SECONDS:
                    cls._last_recovery = loop_time
                    recovered = await cls.recover_interrupted_jobs()
                    if recovered:
                        logger.warning("Re-queued %d job(s) whose worker stopped", recovered)
                job_id = await cls._claim_next_job()
                if job_id is None:
                    if wake is None:
                        await asyncio.sleep(cls.POLL_INTERVAL_SECONDS)
                    else:
                        try:
                            await asyncio.wait_for(wake.wait(), timeout=cls.POLL_INTERVAL_SECONDS)
                        except asyncio.TimeoutError:
                            pass
                    continue
                await cls._process_job(job_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Worker {worker_id} unexpected error: {e}", exc_info=True)
                await asyncio.sleep(1.0)

    # --- pipeline ----------------------------------------------------------

    @classmethod
    async def _process_job(cls, job_id: str) -> None:
        source_path: Path | None = None
        source_should_persist = False
        cls._active_jobs.add(job_id)
        heartbeat = asyncio.create_task(cls._heartbeat(job_id))

        def check_cancelled() -> None:
            if cls._is_cancelled(job_id):
                raise JobCancelled()

        try:
            async with AsyncSessionLocal() as session:
                job = await session.get(Job, job_id)
                if not job or job.status == "cancelled":
                    return

                try:
                    source_path, source_should_persist = await cls._run_pipeline(
                        session, job, check_cancelled
                    )
                except (JobCancelled, DownloadCancelled):
                    await session.rollback()
                    await cls._mark_cancelled(job_id)
                except Exception as e:
                    await session.rollback()
                    if cls._is_cancelled(job_id):
                        await cls._mark_cancelled(job_id)
                        return
                    logger.error(f"Job {job_id} processing failed: {e}", exc_info=True)
                    failure = classify_download_error(e)
                    await cls._record_failure(
                        job_id,
                        status="awaiting_source" if failure.source_required else "failed",
                        failure_code=failure.code,
                        error=str(failure),
                        progress=0 if failure.source_required else 100,
                    )
        finally:
            heartbeat.cancel()
            purge = job_id in cls._purge_jobs
            cls._active_jobs.discard(job_id)
            cls._cancelled_jobs.discard(job_id)
            cls._purge_jobs.discard(job_id)
            if purge:
                StorageManager.delete_job_files(job_id, str(source_path) if source_path else None)
            else:
                # Never leave half-downloaded multi-gigabyte files behind.
                for suffix in (".ts", ".mp4"):
                    remove_partial_downloads(settings.temp_path / f"{job_id}_source{suffix}")
                for leftover in settings.temp_path.glob(f"{job_id}_*_cut.mp4"):
                    leftover.unlink(missing_ok=True)

    @classmethod
    async def _mark_cancelled(cls, job_id: str) -> None:
        """Persist 'cancelled' unless the row was deleted (purge)."""
        if job_id in cls._purge_jobs:
            return
        async with AsyncSessionLocal() as session:
            await session.execute(
                update(Job).where(Job.id == job_id).values(status="cancelled")
            )
            await session.commit()

    @classmethod
    async def _record_failure(cls, job_id: str, **values) -> None:
        async with AsyncSessionLocal() as session:
            await session.execute(update(Job).where(Job.id == job_id).values(**values))
            await session.commit()

    @classmethod
    async def _run_pipeline(cls, session, job: Job, check_cancelled) -> tuple[Path | None, bool]:
        """Acquire the source, cut every segment, write metadata.

        Returns ``(source_path, source_should_persist)`` for final cleanup.
        """
        job_id = job.id
        source_path: Path | None = None
        source_should_persist = False
        errors: list[str] = []

        segments = list(
            (await session.execute(
                select(JobSegment).where(JobSegment.job_id == job.id).order_by(JobSegment.id)
            )).scalars().all()
        )
        required_seconds = max((seg.end_seconds for seg in segments), default=None)

        # 1. Acquire the source
        job.status = "downloading"
        job.progress = 10
        await session.commit()

        headers = dict(job.source_headers or {})
        if job.page_url and not any(key.lower() == "referer" for key in headers):
            headers["Referer"] = job.page_url

        async def on_download_progress(pct: int):
            job.progress = min(100, pct)
            await session.commit()

        library_source = None if job.source_file_path else find_library_source(job.media_url)

        if job.source_file_path:
            source_path = Path(job.source_file_path)
            source_should_persist = True
            if not source_path.exists():
                raise FileNotFoundError("Uploaded source file is missing. Upload it again to resume the job.")
            probed_duration = await VideoDownloader._probe_media(source_path)
        elif library_source is not None:
            # The video was tagged while playing from this server's own
            # library: cut the local file instead of downloading it from ourselves.
            source_path = library_source
            source_should_persist = True
            probed_duration = await VideoDownloader._probe_media(source_path)
        elif job.acquisition_mode == "upload":
            job.status = "awaiting_source"
            job.failure_code = "SOURCE_UPLOAD_REQUIRED"
            job.error = "Upload the source video to continue this job."
            job.progress = 0
            await session.commit()
            return None, False
        else:
            target_url, resolved_type, req_headers = await VideoDownloader.resolve_stream(
                media_url=job.media_url,
                media_type=job.media_type,
                variant_url=job.variant_url,
                headers=headers,
                target_height=job.quality_height,
            )
            check_cancelled()
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
                    pre_resolved=True,
                    required_seconds=required_seconds,
                    should_cancel=lambda: cls._is_cancelled(job_id),
                )
            except DownloadCancelled:
                raise
            except Exception as source_error:
                check_cancelled()
                failure = classify_download_error(source_error)
                if failure.source_required:
                    job.status = "awaiting_source"
                    job.failure_code = failure.code
                    job.error = str(failure)
                    job.progress = 0
                    await session.commit()
                    return None, False
                raise failure from source_error

        check_cancelled()

        if required_seconds is not None and probed_duration + 0.05 < required_seconds:
            raise ValueError(
                "Downloaded source is incomplete or mismatched: the video is "
                f"{_format_seconds(probed_duration)} long but the segments go up to "
                f"{_format_seconds(required_seconds)}. It is probably a different video "
                "(an ad, a preview or another clip) than the one that was tagged."
            )

        if settings.KEEP_DOWNLOADED_SOURCES and source_path and not source_should_persist:
            archived_source = settings.downloads_path / f"{job.id}_source{source_path.suffix or '.mp4'}"
            archived_source.unlink(missing_ok=True)
            await asyncio.to_thread(shutil.move, str(source_path), str(archived_source))
            source_path = archived_source
            source_should_persist = True
            job.source_file_path = str(source_path)
            await session.commit()
            ThumbnailWorker.schedule("_downloads", archived_source.name)

        try:
            # The browser-reported duration is not enforced: streaming sites
            # often report values that differ wildly from the real payload.
            job.duration_seconds = probed_duration
            job.failure_code = None
            job.error = None

            check_cancelled()

            # 2. Cut segments
            job.status = "processing"
            job.progress = 0
            await session.commit()

            segment_records = []
            success_count = 0
            total_segments = len(segments)

            for idx, seg in enumerate(segments):
                check_cancelled()
                temp_cut_out = settings.temp_path / f"{job.id}_{seg.segment_id}_cut.mp4"

                try:
                    actual_dur = await VideoProcessor.extract_segment(
                        source_path=source_path,
                        output_path=temp_cut_out,
                        start_seconds=seg.start_seconds,
                        end_seconds=seg.end_seconds,
                        total_duration=probed_duration,
                    )
                    check_cancelled()

                    stored_files = StorageManager.store_segment_files(
                        job_id=job.id,
                        segment_id=seg.segment_id,
                        temp_segment_path=temp_cut_out,
                        category_ids=seg.categories,
                    )

                    locations = [(Path(p).parent.name, Path(p).name) for p in stored_files]
                    if locations:
                        # One render per clip; extra categories reuse the image.
                        ThumbnailWorker.schedule(*locations[0], also=locations[1:])

                    seg.status = "completed"
                    seg.duration = actual_dur
                    seg.error = None
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
                except JobCancelled:
                    temp_cut_out.unlink(missing_ok=True)
                    raise
                except Exception as seg_err:
                    temp_cut_out.unlink(missing_ok=True)
                    check_cancelled()
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

                job.progress = min(100, int(((idx + 1) / total_segments) * 100))
                await session.commit()

            # 3. Generate traceable CVAT metadata JSON
            StorageManager.save_job_metadata(
                job_id=job.id,
                page_url=job.page_url,
                media_url=job.media_url,
                media_type=job.media_type,
                quality={"height": job.quality_height, "representation_id": job.representation_id},
                source_duration=probed_duration,
                segment_records=segment_records,
                errors=errors,
            )

            # 4. Final status determination
            check_cancelled()
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
        finally:
            if source_path and not source_should_persist:
                try:
                    source_path.unlink(missing_ok=True)
                except OSError:
                    pass

        return source_path, source_should_persist
