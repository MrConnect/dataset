import pytest
from pathlib import Path
from httpx import AsyncClient

from app.config import settings
from app.db.session import AsyncSessionLocal
from app.models.job import Job


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] in ("healthy", "degraded")
    assert data["ffmpeg"] == "available"
    assert data["ffprobe"] == "available"


@pytest.mark.asyncio
async def test_auth_rejection(client: AsyncClient):
    # Without auth header
    res = await client.get("/api/v1/categories")
    assert res.status_code == 401

    # With invalid auth header
    res = await client.get("/api/v1/categories", headers={"X-API-Key": "wrong_key"})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_submit_job_validation(client: AsyncClient, auth_headers: dict):
    # Test invalid interval (end_seconds <= start_seconds)
    invalid_payload = {
        "schema_version": "1.0",
        "source": {
            "page_url": "https://example.com/video/1",
            "media_url": "https://example.com/video.mp4",
            "type": "mp4",
        },
        "segments": [
            {
                "id": "seg_01",
                "start_seconds": 15.0,
                "end_seconds": 10.0,  # Invalid!
                "categories": ["person_walking"],
            }
        ],
    }

    res = await client.post("/api/v1/jobs", json=invalid_payload, headers=auth_headers)
    assert res.status_code == 422

    # Test invalid segment ID (directory traversal attempt)
    traversal_payload = {
        "schema_version": "1.0",
        "source": {
            "page_url": "https://example.com/video/1",
            "media_url": "https://example.com/video.mp4",
            "type": "mp4",
        },
        "segments": [
            {
                "id": "../../bad_id",
                "start_seconds": 5.0,
                "end_seconds": 10.0,
                "categories": ["person_walking"],
            }
        ],
    }
    res = await client.post("/api/v1/jobs", json=traversal_payload, headers=auth_headers)
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_submit_valid_job_and_retrieve(client: AsyncClient, auth_headers: dict):
    payload = {
        "schema_version": "1.0",
        "source": {
            "page_url": "https://example.com/watch?v=123",
            "media_url": "https://cdn.example.com/sample.mp4",
            "type": "mp4",
            "duration_seconds": 120.0,
        },
        "quality": {
            "height": 720,
        },
        "segments": [
            {
                "id": "seg_001",
                "start_seconds": 10.5,
                "end_seconds": 25.0,
                "categories": ["person_walking", "action_gesture"],
            },
            {
                "id": "seg_002",
                "start_seconds": 30.0,
                "end_seconds": 45.0,
                "categories": ["vehicle_car"],
            },
        ],
        "categories_metadata": [
            {
                "id": "person_walking",
                "name": "Person Walking",
                "color": "#22C55E",
            }
        ],
    }

    # Submit
    res = await client.post("/api/v1/jobs", json=payload, headers=auth_headers)
    assert res.status_code == 202
    data = res.json()
    assert "job_id" in data
    assert data["status"] == "queued"
    assert data["segments_count"] == 2

    job_id = data["job_id"]

    # Retrieve job details
    get_res = await client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers)
    assert get_res.status_code == 200
    job_detail = get_res.json()
    assert job_detail["job_id"] == job_id
    assert job_detail["segments_count"] == 2
    assert len(job_detail["segments"]) == 2

    # List jobs
    list_res = await client.get("/api/v1/jobs", headers=auth_headers)
    assert list_res.status_code == 200
    jobs_list = list_res.json()
    assert len(jobs_list) >= 1
    assert any(j["job_id"] == job_id for j in jobs_list)

    # Cancel job
    cancel_res = await client.post(f"/api/v1/jobs/{job_id}/cancel", headers=auth_headers)
    assert cancel_res.status_code == 200
    assert cancel_res.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_undo_job_deletes_database_and_all_artifacts(
    client: AsyncClient,
    auth_headers: dict,
    monkeypatch,
    tmp_path: Path,
):
    dataset_dir = tmp_path / "dataset"
    storage_dir = tmp_path / "storage"
    temp_dir = storage_dir / "temp"
    monkeypatch.setattr(settings, "DATASET_DIR", str(dataset_dir))
    monkeypatch.setattr(settings, "BASE_STORAGE_DIR", str(storage_dir))
    monkeypatch.setattr(settings, "TEMP_DIR", str(temp_dir))

    payload = {
        "schema_version": "2.0",
        "source": {
            "page_url": "https://example.com/watch",
            "media_url": "https://example.com/video.mp4",
            "type": "mp4",
            "duration_seconds": 30.0,
        },
        "segments": [
            {
                "id": "seg_delete_me",
                "start_seconds": 2.0,
                "end_seconds": 4.0,
                "categories": ["walking"],
            }
        ],
    }
    submitted = await client.post("/api/v1/jobs", json=payload, headers=auth_headers)
    assert submitted.status_code == 202
    job_id = submitted.json()["job_id"]

    source = storage_dir / "downloads" / f"{job_id}_source.mp4"
    temporary = temp_dir / f"{job_id}_seg_delete_me_cut.mp4"
    clip = dataset_dir / "walking" / f"{job_id}_seg_delete_me.mp4"
    metadata = dataset_dir / "metadata" / f"{job_id}.json"
    for path in (source, temporary, clip, metadata):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"artifact")

    async with AsyncSessionLocal() as session:
        job = await session.get(Job, job_id)
        assert job is not None
        job.source_file_path = str(source)
        await session.commit()

    deleted = await client.delete(f"/api/v1/jobs/{job_id}", headers=auth_headers)
    assert deleted.status_code == 200
    assert deleted.json()["deleted_files"] == 4
    assert all(not path.exists() for path in (source, temporary, clip, metadata))

    missing = await client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers)
    assert missing.status_code == 404
