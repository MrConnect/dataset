import asyncio
import subprocess
from pathlib import Path
import pytest
from httpx import AsyncClient
from app.config import settings
from app.workers.queue import JobWorkerQueue


@pytest.mark.asyncio
async def test_full_e2e_job_lifecycle(client: AsyncClient, auth_headers: dict, tmp_path: Path):
    # Temporarily allow local files/network for testing
    settings.ALLOW_LOCAL_NETWORK = True

    # 1. Create a local synthetic video file
    synthetic_file = tmp_path / "e2e_sample.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-f", "lavfi",
        "-i", "testsrc=duration=6:size=320x240:rate=25",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=6",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        str(synthetic_file),
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert res.returncode == 0
    assert synthetic_file.exists()

    # We can use file URI or mock download by patching downloader directly for this test
    # Let's test the processing directly via worker
    from app.services.downloader import VideoDownloader

    async def mock_download_source(job_id, media_url, media_type, variant_url=None, headers=None, **kwargs):
        return synthetic_file, 6.0

    original_download = VideoDownloader.download_source
    VideoDownloader.download_source = mock_download_source

    try:
        # Start worker queue for test
        await JobWorkerQueue.start(num_workers=1)

        payload = {
            "schema_version": "1.0",
            "source": {
                "page_url": "https://example.com/stream/e2e",
                "media_url": "https://example.com/e2e_sample.mp4",
                "type": "mp4",
                "duration_seconds": 6.0,
            },
            "quality": {"height": 240},
            "segments": [
                {
                    "id": "e2e_seg_1",
                    "start_seconds": 1.0,
                    "end_seconds": 3.0,
                    "categories": ["person_running"],
                },
                {
                    "id": "e2e_seg_2",
                    "start_seconds": 3.5,
                    "end_seconds": 5.5,
                    "categories": ["person_running", "face_closeup"],
                },
            ],
            "categories_metadata": [
                {
                    "id": "person_running",
                    "name": "Person Running",
                    "color": "#3B82F6",
                },
                {
                    "id": "face_closeup",
                    "name": "Face Close-up",
                    "color": "#8B5CF6",
                },
            ],
        }

        # Submit Job
        submit_res = await client.post("/api/v1/jobs", json=payload, headers=auth_headers)
        assert submit_res.status_code == 202
        job_id = submit_res.json()["job_id"]

        # Wait for worker to finish processing
        completed = False
        for _ in range(30):
            await asyncio.sleep(0.5)
            status_res = await client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers)
            assert status_res.status_code == 200
            current_status = status_res.json()["status"]
            if current_status == "completed":
                completed = True
                break
            elif current_status == "failed":
                pytest.fail(f"Job failed unexpectedly: {status_res.json().get('error')}")

        assert completed, "Job did not complete within timeout"

        # Verify segments exist in dataset folders
        seg1_path = settings.dataset_path / "person_running" / f"{job_id}_e2e_seg_1.mp4"
        seg2_path_cat1 = settings.dataset_path / "person_running" / f"{job_id}_e2e_seg_2.mp4"
        seg2_path_cat2 = settings.dataset_path / "face_closeup" / f"{job_id}_e2e_seg_2.mp4"

        assert seg1_path.exists()
        assert seg2_path_cat1.exists()
        assert seg2_path_cat2.exists()

        # Verify metadata file was generated
        meta_file = settings.dataset_path / "metadata" / f"{job_id}.json"
        assert meta_file.exists()

    finally:
        VideoDownloader.download_source = original_download
        await JobWorkerQueue.stop()
        settings.ALLOW_LOCAL_NETWORK = False
