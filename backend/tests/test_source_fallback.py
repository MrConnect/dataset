from pathlib import Path

import pytest

from app.db.session import AsyncSessionLocal
from app.models.job import Job
from app.services.downloader import VideoDownloader
from app.workers.queue import JobWorkerQueue


def job_payload(*, acquisition_mode: str = "auto") -> dict:
    return {
        "schema_version": "2.0",
        "source": {
            "page_url": "https://example.com/watch/episode",
            "media_url": "https://cdn.example.com/master.m3u8?token=browser-ip",
            "type": "hls",
            "headers": {
                "Referer": "https://player.example.com/embed/episode",
                "Origin": "https://player.example.com",
                "X-Ignored": "not persisted",
            },
            "acquisition_mode": acquisition_mode,
        },
        "segments": [
            {
                "id": "seg_01",
                "start_seconds": 1,
                "end_seconds": 2,
                "categories": ["action"],
            }
        ],
    }


@pytest.mark.asyncio
async def test_403_transitions_job_to_awaiting_source(client, auth_headers, monkeypatch):
    response = await client.post("/api/v1/jobs", json=job_payload(), headers=auth_headers)
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    async def passthrough(media_url, media_type, headers=None, **_kwargs):
        assert headers == {
            "Referer": "https://player.example.com/embed/episode",
            "Origin": "https://player.example.com",
        }
        return media_url, media_type, headers

    async def forbidden(*_args, **_kwargs):
        raise RuntimeError("FFmpeg download failed: HTTP error 403 Forbidden")

    monkeypatch.setattr(VideoDownloader, "resolve_stream", passthrough)
    monkeypatch.setattr(VideoDownloader, "download_source", forbidden)

    await JobWorkerQueue._process_job(job_id)

    details = await client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers)
    assert details.status_code == 200
    data = details.json()
    assert data["status"] == "awaiting_source"
    assert data["failure_code"] == "SOURCE_ACCESS_DENIED"
    assert data["source_required"] is True
    assert "Upload" in data["error"]


@pytest.mark.asyncio
async def test_upload_source_resumes_same_job(client, auth_headers, monkeypatch, tmp_path):
    response = await client.post(
        "/api/v1/jobs",
        json=job_payload(acquisition_mode="upload"),
        headers=auth_headers,
    )
    job_id = response.json()["job_id"]

    queued: list[str] = []

    async def capture_enqueue(value: str):
        queued.append(value)

    monkeypatch.setattr(JobWorkerQueue, "enqueue_job", capture_enqueue)
    upload = await client.post(
        f"/api/v1/jobs/{job_id}/source",
        headers=auth_headers,
        files={"file": ("episode.mp4", b"synthetic-video", "video/mp4")},
    )
    assert upload.status_code == 202
    assert queued == [job_id]

    async with AsyncSessionLocal() as session:
        job = await session.get(Job, job_id)
        assert job is not None
        assert job.status == "queued"
        assert job.acquisition_mode == "upload"
        assert job.failure_code is None
        assert job.source_file_path is not None
        source_path = Path(job.source_file_path)
        assert source_path.read_bytes() == b"synthetic-video"
        source_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_upload_mode_waits_without_attempting_remote_download(client, auth_headers, monkeypatch):
    response = await client.post(
        "/api/v1/jobs",
        json=job_payload(acquisition_mode="upload"),
        headers=auth_headers,
    )
    job_id = response.json()["job_id"]

    async def should_not_run(*_args, **_kwargs):
        raise AssertionError("remote downloader should not run in upload mode")

    monkeypatch.setattr(VideoDownloader, "download_source", should_not_run)
    await JobWorkerQueue._process_job(job_id)

    details = await client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers)
    data = details.json()
    assert data["status"] == "awaiting_source"
    assert data["failure_code"] == "SOURCE_UPLOAD_REQUIRED"
