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
