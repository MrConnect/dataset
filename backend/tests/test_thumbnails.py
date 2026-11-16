"""Thumbnails stay in sync with file operations, like a file manager's cache."""

import asyncio
import os
import time
from pathlib import Path

import pytest

from app.config import settings
from app.services import thumbnails


@pytest.fixture
def library(monkeypatch, tmp_path: Path, auth_headers):
    monkeypatch.setattr(settings, "BASE_STORAGE_DIR", str(tmp_path / "storage"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "storage" / "temp"))
    monkeypatch.setattr(settings, "DATASET_DIR", str(tmp_path / "dataset"))
    walking = tmp_path / "dataset" / "walking"
    walking.mkdir(parents=True)
    (walking / "a.mp4").write_bytes(b"video-a")
    (walking / "b.mp4").write_bytes(b"video-b")

    renders: list[str] = []

    def fake_render(source: Path, destination: Path) -> bool:
        renders.append(source.name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"jpeg:" + source.read_bytes())
        return True

    monkeypatch.setattr(thumbnails, "_render", fake_render)
    return tmp_path, renders


def thumb(root: Path, category: str, name: str) -> Path:
    return root / "storage" / "thumbs" / category / f"{name}.jpg"


@pytest.mark.asyncio
async def test_thumbnail_is_generated_once_and_cached(client, auth_headers, library):
    root, renders = library
    url = "/api/v1/dataset/thumb/walking/a.mp4"

    assert (await client.get(url)).status_code == 401

    first = await client.get(url, headers=auth_headers)
    second = await client.get(url, headers=auth_headers)
    assert first.status_code == 200 and first.headers["content-type"] == "image/jpeg"
    assert first.content == second.content == b"jpeg:video-a"
    assert renders == ["a.mp4"]

    listing = (await client.get("/api/v1/dataset/", headers=auth_headers)).json()
    walking = next(c for c in listing["categories"] if c["name"] == "walking")
    assert all(v["thumb"].startswith("/api/v1/dataset/thumb/walking/") for v in walking["videos"])


@pytest.mark.asyncio
async def test_concurrent_requests_share_one_render(client, auth_headers, library):
    _root, renders = library
    responses = await asyncio.gather(*[
        client.get("/api/v1/dataset/thumb/walking/a.mp4", headers=auth_headers) for _ in range(5)
    ])
    assert {r.status_code for r in responses} == {200}
    assert renders == ["a.mp4"]


@pytest.mark.asyncio
async def test_rename_and_move_carry_the_thumbnail(client, auth_headers, library):
    root, renders = library
    await client.get("/api/v1/dataset/thumb/walking/a.mp4", headers=auth_headers)

    renamed = await client.post(
        "/api/v1/dataset/move",
        json={"old_category": "walking", "old_filename": "a.mp4", "new_category": "walking", "new_filename": "hero.mp4"},
        headers=auth_headers,
    )
    assert renamed.status_code == 200
    assert not thumb(root, "walking", "a.mp4").exists()
    assert thumb(root, "walking", "hero.mp4").exists()

    moved = await client.post(
        "/api/v1/dataset/bulk/move",
        json={"files": [{"category": "walking", "filename": "hero.mp4"}], "new_category": "running"},
        headers=auth_headers,
    )
    assert moved.status_code == 200
    assert thumb(root, "running", "hero.mp4").exists()

    served = await client.get("/api/v1/dataset/thumb/running/hero.mp4", headers=auth_headers)
    assert served.content == b"jpeg:video-a"
    assert renders == ["a.mp4"]  # reused, never regenerated
    assert (await client.get("/api/v1/dataset/thumb/walking/a.mp4", headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_delete_removes_thumbnail_and_empty_folder(client, auth_headers, library):
    root, _renders = library
    for name in ("a.mp4", "b.mp4"):
        await client.get(f"/api/v1/dataset/thumb/walking/{name}", headers=auth_headers)

    await client.delete("/api/v1/dataset/walking/a.mp4", headers=auth_headers)
    assert not thumb(root, "walking", "a.mp4").exists()
    assert thumb(root, "walking", "b.mp4").exists()

    await client.post(
        "/api/v1/dataset/bulk/delete",
        json={"files": [{"category": "walking", "filename": "b.mp4"}]},
        headers=auth_headers,
    )
    assert not (root / "storage" / "thumbs" / "walking").exists()
    assert not (root / "dataset" / "walking").exists()


@pytest.mark.asyncio
async def test_replaced_file_gets_a_new_thumbnail(client, auth_headers, library):
    root, renders = library
    url = "/api/v1/dataset/thumb/walking/a.mp4"
    await client.get(url, headers=auth_headers)

    source = root / "dataset" / "walking" / "a.mp4"
    source.write_bytes(b"video-a-v2")
    future = time.time() + 5
    os.utime(source, (future, future))

    again = await client.get(url, headers=auth_headers)
    assert again.content == b"jpeg:video-a-v2"
    assert renders == ["a.mp4", "a.mp4"]


@pytest.mark.asyncio
async def test_unreadable_video_is_not_retried(client, auth_headers, library, monkeypatch):
    attempts: list[str] = []

    def failing_render(source: Path, _destination: Path) -> bool:
        attempts.append(source.name)
        return False

    monkeypatch.setattr(thumbnails, "_render", failing_render)
    for _ in range(3):
        response = await client.get("/api/v1/dataset/thumb/walking/a.mp4", headers=auth_headers)
        assert response.status_code == 404
    assert attempts == ["a.mp4"]


@pytest.mark.asyncio
async def test_orphan_sweep_and_non_video(client, auth_headers, library):
    root, _renders = library
    from app.api.dataset import source_dir_for

    await client.get("/api/v1/dataset/thumb/walking/a.mp4", headers=auth_headers)
    (root / "dataset" / "walking" / "a.mp4").unlink()  # removed behind the API's back
    assert thumbnails.sweep_orphans(source_dir_for) == 1
    assert not thumb(root, "walking", "a.mp4").exists()

    (root / "dataset" / "walking" / "notes.txt").write_text("x")
    assert (await client.get("/api/v1/dataset/thumb/walking/notes.txt", headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_create_category(client, auth_headers, library):
    root, _renders = library
    created = await client.post("/api/v1/dataset/category", json={"name": "jumping"}, headers=auth_headers)
    assert created.status_code == 201
    assert (root / "dataset" / "jumping").is_dir()
    assert (await client.post("/api/v1/dataset/category", json={"name": "jumping"}, headers=auth_headers)).status_code == 409
    assert (await client.post("/api/v1/dataset/category", json={"name": "../x"}, headers=auth_headers)).status_code == 400
    assert (await client.post("/api/v1/dataset/category", json={"name": "_temp"}, headers=auth_headers)).status_code == 400


@pytest.mark.asyncio
async def test_new_clip_is_rendered_once_in_background(library):
    root, renders = library
    running = root / "dataset" / "running"
    running.mkdir()
    (running / "a.mp4").write_bytes((root / "dataset" / "walking" / "a.mp4").read_bytes())

    thumbnails.ThumbnailWorker.start()
    try:
        # The same clip stored under two categories: one render, one copy.
        thumbnails.ThumbnailWorker.schedule("walking", "a.mp4", also=[("running", "a.mp4")])
        thumbnails.ThumbnailWorker.schedule("walking", "a.mp4")  # duplicate request is ignored
        await thumbnails.ThumbnailWorker.drain()
    finally:
        await thumbnails.ThumbnailWorker.stop()

    assert renders == ["a.mp4"]
    assert thumb(root, "walking", "a.mp4").read_bytes() == b"jpeg:video-a"
    assert thumb(root, "running", "a.mp4").read_bytes() == b"jpeg:video-a"


@pytest.mark.asyncio
async def test_listing_reports_ready_thumbnails_without_rendering(client, auth_headers, library):
    root, renders = library
    thumbnails.ThumbnailWorker.start()
    try:
        thumbnails.ThumbnailWorker.schedule("walking", "a.mp4")
        await thumbnails.ThumbnailWorker.drain()
    finally:
        await thumbnails.ThumbnailWorker.stop()

    listing = (await client.get("/api/v1/dataset/", headers=auth_headers)).json()
    walking = {v["filename"]: v for c in listing["categories"] if c["name"] == "walking" for v in c["videos"]}
    assert walking["a.mp4"]["thumb_ready"] is True
    assert walking["b.mp4"]["thumb_ready"] is False
    assert renders == ["a.mp4"]  # listing itself never renders


@pytest.mark.asyncio
async def test_backfill_rebuilds_only_missing_thumbnails(library):
    root, renders = library
    downloads = root / "storage" / "downloads"
    downloads.mkdir(parents=True)
    (downloads / "movie.mkv").write_bytes(b"movie")

    thumbnails.ThumbnailWorker.start()
    try:
        assert await thumbnails.ThumbnailWorker.backfill() == 3
        await thumbnails.ThumbnailWorker.drain()
        assert sorted(renders) == ["a.mp4", "b.mp4", "movie.mkv"]

        # Nothing to do when every image exists...
        assert await thumbnails.ThumbnailWorker.backfill() == 0
        # ...and only the lost one is rebuilt.
        thumb(root, "walking", "b.mp4").unlink()
        assert await thumbnails.ThumbnailWorker.backfill() == 1
        await thumbnails.ThumbnailWorker.drain()
    finally:
        await thumbnails.ThumbnailWorker.stop()

    assert sorted(renders) == ["a.mp4", "b.mp4", "b.mp4", "movie.mkv"]
    assert thumb(root, "walking", "b.mp4").exists()
