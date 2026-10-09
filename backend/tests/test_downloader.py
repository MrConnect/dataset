import pytest

from app.config import settings
from app.services.downloader import VideoDownloader


@pytest.mark.asyncio
async def test_hls_download_keeps_native_transport_stream(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    async def resolve_stream(*_args, **_kwargs):
        return "https://cdn.example.com/episode.m3u8?token=abc", "hls", {"Referer": "https://example.com/"}

    async def download(url, destination, headers, *_args, **kwargs):
        captured.update(
            url=url,
            destination=destination,
            headers=headers,
            is_hls=kwargs.get("is_hls"),
        )
        destination.write_bytes(b"transport-stream" * 512)

    async def probe(path):
        assert path.suffix == ".ts"
        return 2650.189

    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path))
    monkeypatch.setattr(VideoDownloader, "resolve_stream", resolve_stream)
    monkeypatch.setattr(VideoDownloader, "_download_via_ffmpeg", download)
    monkeypatch.setattr(VideoDownloader, "_probe_media", probe)

    path, duration = await VideoDownloader.download_source(
        job_id="job_hls",
        media_url="https://cdn.example.com/master.m3u8",
        media_type="hls",
    )

    assert path == tmp_path / "job_hls_source.ts"
    assert duration == pytest.approx(2650.189)
    assert captured["is_hls"] is True


@pytest.mark.asyncio
async def test_dash_download_remains_mp4(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    async def resolve_stream(*_args, **_kwargs):
        return "https://cdn.example.com/manifest.mpd", "dash", {}

    async def download(_url, destination, _headers, *_args, **kwargs):
        captured["destination"] = destination
        captured["is_hls"] = kwargs.get("is_hls")
        destination.write_bytes(b"mp4-data" * 1024)

    async def probe(path):
        assert path.suffix == ".mp4"
        return 42.0

    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path))
    monkeypatch.setattr(VideoDownloader, "resolve_stream", resolve_stream)
    monkeypatch.setattr(VideoDownloader, "_download_via_ffmpeg", download)
    monkeypatch.setattr(VideoDownloader, "_probe_media", probe)

    path, duration = await VideoDownloader.download_source(
        job_id="job_dash",
        media_url="https://cdn.example.com/manifest.mpd",
        media_type="dash",
    )

    assert path == tmp_path / "job_dash_source.mp4"
    assert duration == 42.0
    assert captured["is_hls"] is False
