"""Auth, key management, storage exposure and SSRF hardening."""

from pathlib import Path

import pytest

from app.config import settings
from app.core.ssrf import SSRFBlocked, validate_url_safety


@pytest.mark.asyncio
async def test_dataset_api_requires_a_key(client):
    assert (await client.get("/api/v1/dataset/")).status_code == 401
    assert (await client.post("/api/v1/dataset/bulk/delete", json={"files": []})).status_code == 401
    assert (await client.delete("/api/v1/dataset/cat/file.mp4")).status_code == 401
    assert (await client.post("/api/v1/uploads", json={"filename": "a.mp4", "size": 10})).status_code == 401


@pytest.mark.asyncio
async def test_storage_is_not_served_statically(client):
    assert (await client.get("/storage/tagger.db")).status_code == 404
    assert (await client.get("/media/anything/clip.mp4")).status_code == 404
    assert (await client.get("/api/v1/debug_error")).status_code == 404


@pytest.mark.asyncio
async def test_client_key_lifecycle(client, auth_headers):
    created = await client.post("/api/v1/keys", json={"name": "Laptop extension"}, headers=auth_headers)
    assert created.status_code == 201
    body = created.json()
    client_headers = {"X-API-Key": body["key"]}

    # The client key works for the pipeline...
    assert (await client.get("/api/v1/categories", headers=client_headers)).status_code == 200
    assert (await client.get("/api/v1/auth/me", headers=client_headers)).json()["role"] == "client"
    # ...but cannot manage keys or the database.
    assert (await client.get("/api/v1/keys", headers=client_headers)).status_code == 403
    assert (await client.get("/api/v1/system/database", headers=client_headers)).status_code == 403

    listed = await client.get("/api/v1/keys", headers=auth_headers)
    assert [item["id"] for item in listed.json()] == [body["id"]]
    assert "key" not in listed.json()[0]

    revoked = await client.delete(f"/api/v1/keys/{body['id']}", headers=auth_headers)
    assert revoked.status_code == 204
    assert (await client.get("/api/v1/categories", headers=client_headers)).status_code == 401


@pytest.mark.asyncio
async def test_media_cookie_unlocks_only_file_reads(client, auth_headers, monkeypatch, tmp_path: Path):
    dataset_dir = tmp_path / "dataset"
    (dataset_dir / "walking").mkdir(parents=True)
    (dataset_dir / "walking" / "clip.mp4").write_bytes(b"clip-bytes")
    monkeypatch.setattr(settings, "DATASET_DIR", str(dataset_dir))

    url = "/api/v1/dataset/file/walking/clip.mp4"
    assert (await client.get(url)).status_code == 401

    session = await client.post("/api/v1/auth/session", headers=auth_headers)
    assert session.status_code == 200
    token = session.cookies.get("vdt_media")
    assert token
    client.cookies.clear()

    cookie = {"Cookie": f"vdt_media={token}"}
    served = await client.get(url, headers=cookie)
    assert served.status_code == 200
    assert served.content == b"clip-bytes"
    assert served.headers["x-content-type-options"] == "nosniff"

    # The cookie must not authorise anything that changes state.
    assert (await client.delete("/api/v1/dataset/walking/clip.mp4", headers=cookie)).status_code == 401
    assert (await client.get("/api/v1/jobs", headers=cookie)).status_code == 401
    assert (await client.get(url, headers={"Cookie": "vdt_media=1.deadbeef"})).status_code == 401


@pytest.mark.asyncio
async def test_non_video_library_upload_is_rejected(client, auth_headers, monkeypatch, tmp_path: Path):
    monkeypatch.setattr(settings, "BASE_STORAGE_DIR", str(tmp_path))
    response = await client.post(
        "/api/v1/dataset/upload_video",
        files={"file": ("page.html", b"<script>alert(1)</script>", "text/html")},
        headers=auth_headers,
    )
    assert response.status_code == 415


@pytest.mark.asyncio
async def test_database_reset_requires_admin_and_confirmation(client, auth_headers):
    refused = await client.post("/api/v1/system/database/reset", json={"confirm": "no"}, headers=auth_headers)
    assert refused.status_code == 400
    done = await client.post("/api/v1/system/database/reset", json={"confirm": "RESET"}, headers=auth_headers)
    assert done.status_code == 200
    info = await client.get("/api/v1/system/database", headers=auth_headers)
    assert info.json()["jobs"] == 0


def test_ssrf_blocks_ipv4_tunnelled_in_ipv6(monkeypatch):
    monkeypatch.setattr(settings, "ALLOW_LOCAL_NETWORK", False)
    for url in (
        "http://[::ffff:127.0.0.1]/admin",
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
        "http://[64:ff9b::a00:1]/",
        "http://[::1]:8000/",
        "http://100.64.1.1/",
    ):
        with pytest.raises(SSRFBlocked):
            validate_url_safety(url)
