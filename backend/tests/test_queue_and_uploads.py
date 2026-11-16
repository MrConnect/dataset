"""Database-backed queue, download completeness and resumable uploads."""

import sys
from pathlib import Path

import pytest

from app.config import settings
from app.db.session import AsyncSessionLocal
from app.models.job import Job
from app.services.downloader import VideoDownloader
from app.services.media_probe import MediaInfo
from app.workers.queue import JobWorkerQueue


def payload(end_seconds: float = 20.0, duration: float | None = 100.0, mode: str = "auto") -> dict:
    return {
        "schema_version": "2.0",
        "source": {
            "page_url": "https://example.com/watch",
            "media_url": "https://cdn.example.com/video.m3u8",
            "type": "hls",
            "duration_seconds": duration,
            "acquisition_mode": mode,
        },
        "segments": [{"id": "seg_1", "start_seconds": 5, "end_seconds": end_seconds, "categories": ["walking"]}],
    }


@pytest.fixture
def storage(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(settings, "BASE_STORAGE_DIR", str(tmp_path / "storage"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "storage" / "temp"))
    monkeypatch.setattr(settings, "DATASET_DIR", str(tmp_path / "dataset"))
    return tmp_path


async def _status(job_id: str) -> str:
    async with AsyncSessionLocal() as session:
        return (await session.get(Job, job_id)).status


@pytest.mark.asyncio
async def test_interrupted_jobs_are_requeued_and_claimed_in_order(client, auth_headers):
    first = (await client.post("/api/v1/jobs", json=payload(), headers=auth_headers)).json()["job_id"]
    second = (await client.post("/api/v1/jobs", json=payload(), headers=auth_headers)).json()["job_id"]

    # Simulate a crash while the first job was mid-download.
    async with AsyncSessionLocal() as session:
        job = await session.get(Job, first)
        job.status = "downloading"
        await session.commit()

    assert await JobWorkerQueue.recover_interrupted_jobs() == 1
    assert await _status(first) == "queued"

    assert await JobWorkerQueue._claim_next_job() == first
    assert await _status(first) == "downloading"
    assert await JobWorkerQueue._claim_next_job() == second
    assert await JobWorkerQueue._claim_next_job() is None


@pytest.mark.asyncio
async def test_cancelled_job_is_never_claimed(client, auth_headers):
    job_id = (await client.post("/api/v1/jobs", json=payload(), headers=auth_headers)).json()["job_id"]
    await client.post(f"/api/v1/jobs/{job_id}/cancel", headers=auth_headers)
    assert await JobWorkerQueue._claim_next_job() is None
    assert job_id not in JobWorkerQueue._cancelled_jobs  # nothing leaks for idle jobs


@pytest.mark.asyncio
async def test_truncated_download_is_not_accepted(storage, monkeypatch):
    async def failing_tool(_url, destination, *_args, **_kwargs):
        destination.write_bytes(b"x" * 8192)
        return 1, "ERROR: fragment 812 not found, giving up"

    async def short_probe(_path):
        return 600.0

    monkeypatch.setattr(VideoDownloader, "_download_via_ffmpeg", failing_tool)
    monkeypatch.setattr(VideoDownloader, "_probe_media", short_probe)

    with pytest.raises(ValueError, match="incomplete or mismatched"):
        await VideoDownloader.download_source(
            job_id="job_trunc", media_url="https://cdn.example.com/v.m3u8", media_type="hls",
            pre_resolved=True, required_seconds=1500.0,
        )
    assert not list(Path(settings.TEMP_DIR).glob("job_trunc_source*"))

    # Same exit code, but the file covers every segment: usable.
    path, duration = await VideoDownloader.download_source(
        job_id="job_ok", media_url="https://cdn.example.com/v.m3u8", media_type="hls",
        pre_resolved=True, required_seconds=590.0,
    )
    assert path.exists() and duration == 600.0


@pytest.mark.asyncio
async def test_hung_download_is_killed(storage, monkeypatch):
    monkeypatch.setattr(settings, "DOWNLOAD_STALL_TIMEOUT_SECONDS", 2)
    monkeypatch.setattr(
        VideoDownloader, "_build_download_command",
        staticmethod(lambda *_a, **_k: [sys.executable, "-c", "import time; time.sleep(60)"]),
    )
    destination = Path(settings.TEMP_DIR)
    destination.mkdir(parents=True, exist_ok=True)
    with pytest.raises(TimeoutError, match="no progress"):
        await VideoDownloader._download_via_ffmpeg("https://x.example/v.m3u8", destination / "hang.ts", {}, is_hls=True)


@pytest.mark.asyncio
async def test_chunked_upload_resumes_and_requeues_job(client, auth_headers, storage, monkeypatch):
    async def fake_probe(_path):
        return MediaInfo(duration=98.0, width=1920, height=1080)

    monkeypatch.setattr("app.services.source_intake.probe_video", fake_probe)

    job_id = (await client.post("/api/v1/jobs", json=payload(mode="upload"), headers=auth_headers)).json()["job_id"]
    data = b"0123456789" * 1000

    created = await client.post(
        "/api/v1/uploads", json={"filename": "movie.mkv", "size": len(data), "job_id": job_id}, headers=auth_headers
    )
    assert created.status_code == 201
    upload_id = created.json()["upload_id"]

    first = await client.put(f"/api/v1/uploads/{upload_id}?offset=0", content=data[:4000], headers=auth_headers)
    assert first.json()["received"] == 4000

    # A retry of the same chunk (lost response) is refused and reports where to resume.
    retry = await client.put(f"/api/v1/uploads/{upload_id}?offset=0", content=data[:4000], headers=auth_headers)
    assert retry.status_code == 409
    assert retry.json()["detail"]["received"] == 4000

    early = await client.post(f"/api/v1/uploads/{upload_id}/complete", headers=auth_headers)
    assert early.status_code == 409

    assert (await client.get(f"/api/v1/uploads/{upload_id}", headers=auth_headers)).json()["received"] == 4000
    await client.put(f"/api/v1/uploads/{upload_id}?offset=4000", content=data[4000:], headers=auth_headers)

    done = await client.post(f"/api/v1/uploads/{upload_id}/complete", headers=auth_headers)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "queued"
    assert done.json()["duration_seconds"] == 98.0

    async with AsyncSessionLocal() as session:
        job = await session.get(Job, job_id)
        assert job.status == "queued"
        assert Path(job.source_file_path).read_bytes() == data
        assert Path(job.source_file_path).suffix == ".mkv"
    assert (await client.get(f"/api/v1/uploads/{upload_id}", headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_upload_of_wrong_video_is_rejected(client, auth_headers, storage, monkeypatch):
    async def short_probe(_path):
        return MediaInfo(duration=10.0, width=640, height=360)

    monkeypatch.setattr("app.services.source_intake.probe_video", short_probe)
    job_id = (
        await client.post("/api/v1/jobs", json=payload(end_seconds=20.0, mode="upload"), headers=auth_headers)
    ).json()["job_id"]

    created = await client.post(
        "/api/v1/uploads", json={"filename": "other.mp4", "size": 5000, "job_id": job_id}, headers=auth_headers
    )
    upload_id = created.json()["upload_id"]
    await client.put(f"/api/v1/uploads/{upload_id}?offset=0", content=b"a" * 5000, headers=auth_headers)

    done = await client.post(f"/api/v1/uploads/{upload_id}/complete", headers=auth_headers)
    assert done.status_code == 422
    assert "does not look like the same video" in done.json()["detail"]
    async with AsyncSessionLocal() as session:
        assert (await session.get(Job, job_id)).source_file_path is None


@pytest.mark.asyncio
async def test_upload_rejects_non_video_and_oversize(client, auth_headers, storage):
    bad = await client.post("/api/v1/uploads", json={"filename": "evil.html", "size": 10}, headers=auth_headers)
    assert bad.status_code == 415

    created = await client.post("/api/v1/uploads", json={"filename": "small.mp4", "size": 10}, headers=auth_headers)
    upload_id = created.json()["upload_id"]
    too_much = await client.put(f"/api/v1/uploads/{upload_id}?offset=0", content=b"b" * 11, headers=auth_headers)
    assert too_much.status_code == 413
    assert (await client.get(f"/api/v1/uploads/{upload_id}", headers=auth_headers)).json()["received"] == 0


@pytest.mark.asyncio
async def test_library_video_is_cut_locally_without_download(client, auth_headers, storage, monkeypatch):
    downloads = Path(settings.BASE_STORAGE_DIR) / "downloads"
    downloads.mkdir(parents=True)
    (downloads / "movie.mp4").write_bytes(b"m" * 8192)

    body = payload(mode="auto")
    body["source"]["media_url"] = "https://tagger.example.com/api/v1/dataset/file/_downloads/movie.mp4"
    body["source"]["type"] = "mp4"
    job_id = (await client.post("/api/v1/jobs", json=body, headers=auth_headers)).json()["job_id"]

    async def no_download(*_a, **_k):
        raise AssertionError("must not download the server's own library file")

    async def probe(_path):
        return 100.0

    cut_from: list[Path] = []

    async def fake_cut(source_path, output_path, **_kwargs):
        cut_from.append(Path(source_path))
        output_path.write_bytes(b"clip")
        return 15.0

    monkeypatch.setattr(VideoDownloader, "resolve_stream", no_download)
    monkeypatch.setattr(VideoDownloader, "download_source", no_download)
    monkeypatch.setattr(VideoDownloader, "_probe_media", probe)
    monkeypatch.setattr("app.workers.queue.VideoProcessor.extract_segment", fake_cut)

    await JobWorkerQueue._process_job(job_id)

    assert await _status(job_id) == "completed"
    assert cut_from == [downloads / "movie.mp4"]
    assert (downloads / "movie.mp4").exists()  # the library file is never consumed
