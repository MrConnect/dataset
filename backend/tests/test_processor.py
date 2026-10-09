import json
import subprocess
from pathlib import Path
import pytest
from app.config import settings
from app.services.video_processor import VideoProcessor
from app.services.storage_manager import StorageManager


@pytest.mark.asyncio
async def test_ffmpeg_segment_extraction_and_dataset_organization(tmp_path: Path):
    # 1. Generate a synthetic test video using host FFmpeg
    synthetic_video = tmp_path / "synthetic_test.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-f", "lavfi",
        "-i", "testsrc=duration=5:size=320x240:rate=30",
        "-f", "lavfi",
        "-i", "sine=frequency=1000:duration=5",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        str(synthetic_video),
    ]

    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert res.returncode == 0
    assert synthetic_video.exists()

    # 2. Extract a 2.0-second segment (from 1.0s to 3.0s)
    temp_cut = tmp_path / "cut_segment.mp4"
    actual_duration = await VideoProcessor.extract_segment(
        source_path=synthetic_video,
        output_path=temp_cut,
        start_seconds=1.0,
        end_seconds=3.0,
        total_duration=5.0,
    )

    assert actual_duration >= 1.9 and actual_duration <= 2.1
    assert temp_cut.exists()

    # 3. Store in multiple categories without re-cutting
    job_id = "job_test_123"
    seg_id = "seg_test_001"
    categories = ["cat_walking", "cat_outdoor"]

    stored_paths = StorageManager.store_segment_files(
        job_id=job_id,
        segment_id=seg_id,
        temp_segment_path=temp_cut,
        category_ids=categories,
    )

    assert len(stored_paths) == 2

    # Verify both category paths exist on disk
    file1 = settings.dataset_path / "cat_walking" / f"{job_id}_{seg_id}.mp4"
    file2 = settings.dataset_path / "cat_outdoor" / f"{job_id}_{seg_id}.mp4"
    assert file1.exists()
    assert file2.exists()

    # 4. Save metadata JSON
    meta_path = StorageManager.save_job_metadata(
        job_id=job_id,
        page_url="https://example.com/test",
        media_url="https://example.com/stream.mp4",
        media_type="mp4",
        quality={"height": 720},
        source_duration=5.0,
        segment_records=[
            {
                "segment_id": seg_id,
                "start_seconds": 1.0,
                "end_seconds": 3.0,
                "actual_duration": actual_duration,
                "categories": categories,
                "output_files": stored_paths,
                "status": "completed",
            }
        ],
    )

    assert meta_path.exists()
    with open(meta_path, "r", encoding="utf-8") as f:
        meta_data = json.load(f)
        assert meta_data["job_id"] == job_id
        assert meta_data["segments_count"] == 1
        assert meta_data["segments"][0]["actual_duration"] == actual_duration
