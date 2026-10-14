from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_dashboard_assets_are_served(client):
    page = await client.get("/dashboard/index.html")
    styles = await client.get("/dashboard/styles.css")
    script = await client.get("/dashboard/app.js")

    assert page.status_code == 200
    assert styles.status_code == 200
    assert script.status_code == 200
    assert "FrameForge" in page.text
    assert "Processing jobs" in page.text
    assert "loadAll()" in script.text


@pytest.mark.asyncio
async def test_dataset_rejects_path_traversal(client):
    response = await client.delete("/api/v1/dataset/..%2Fstorage/tagger.db")
    assert response.status_code in {400, 404}


@pytest.mark.asyncio
async def test_duplicate_upload_is_rejected(client, monkeypatch, tmp_path: Path):
    from app.api import dataset

    monkeypatch.setattr(dataset.settings, "BASE_STORAGE_DIR", str(tmp_path))
    first = await client.post("/api/v1/dataset/upload_video", files={"file": ("sample.mp4", b"video", "video/mp4")})
    second = await client.post("/api/v1/dataset/upload_video", files={"file": ("sample.mp4", b"video", "video/mp4")})

    assert first.status_code == 200
    assert first.json()["size"] == 5
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_system_database_cannot_be_deleted_or_moved(client):
    deleted = await client.delete("/api/v1/dataset/_database/tagger.db")
    moved = await client.post(
        "/api/v1/dataset/move",
        json={"old_category": "_database", "old_filename": "tagger.db", "new_category": "archive", "new_filename": "tagger.db"},
    )

    assert deleted.status_code == 403
    assert moved.status_code == 403


@pytest.mark.asyncio
async def test_bulk_delete_and_move(client, monkeypatch, tmp_path: Path):
    from app.api import dataset

    dataset_dir = tmp_path / "dataset"
    monkeypatch.setattr(dataset.settings, "DATASET_DIR", str(dataset_dir))
    source = dataset_dir / "source"
    source.mkdir(parents=True)
    (source / "one.mp4").write_bytes(b"one")
    (source / "two.mp4").write_bytes(b"two")

    moved = await client.post(
        "/api/v1/dataset/bulk/move",
        json={"files": [{"category": "source", "filename": "one.mp4"}], "new_category": "target"},
    )
    deleted = await client.post(
        "/api/v1/dataset/bulk/delete",
        json={"files": [{"category": "source", "filename": "two.mp4"}]},
    )

    assert moved.status_code == 200
    assert (dataset_dir / "target" / "one.mp4").read_bytes() == b"one"
    assert deleted.status_code == 200
    assert not (source / "two.mp4").exists()


@pytest.mark.asyncio
async def test_temp_files_are_listed_and_can_be_deleted(client, monkeypatch, tmp_path: Path):
    from app.api import dataset

    storage_dir = tmp_path / "storage"
    temp_dir = storage_dir / "temp"
    dataset_dir = storage_dir / "dataset"
    temp_dir.mkdir(parents=True)
    temporary = temp_dir / "stale-segment.mp4"
    temporary.write_bytes(b"temporary")
    monkeypatch.setattr(dataset.settings, "BASE_STORAGE_DIR", str(storage_dir))
    monkeypatch.setattr(dataset.settings, "TEMP_DIR", str(temp_dir))
    monkeypatch.setattr(dataset.settings, "DATASET_DIR", str(dataset_dir))

    listed = await client.get("/api/v1/dataset/")
    assert listed.status_code == 200
    temp_category = next(category for category in listed.json()["categories"] if category["name"] == "_temp")
    assert [item["filename"] for item in temp_category["videos"]] == ["stale-segment.mp4"]

    deleted = await client.delete("/api/v1/dataset/_temp/stale-segment.mp4")
    assert deleted.status_code == 200
    assert not temporary.exists()
