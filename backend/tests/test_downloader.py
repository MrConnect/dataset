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


PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:8.091,
s_0.jpg?t=1
#EXTINF:10.0,
s_1.jpg?t=1
#EXTINF:10.0,
s_2.jpg?t=1
#EXT-X-ENDLIST
"""


def test_media_playlist_is_parsed_with_absolute_fragment_urls():
    from app.services.downloader import parse_media_playlist

    info = parse_media_playlist("https://cdn.example.com/hls/720/index_287.m3u8?sig=1", PLAYLIST)
    assert info is not None
    assert round(info.total_seconds, 3) == 28.091
    assert info.fragments[1] == (8.091, "https://cdn.example.com/hls/720/s_1.jpg?t=1")
    assert parse_media_playlist("https://x/live.m3u8", PLAYLIST.replace("#EXT-X-ENDLIST\n", "")) is None


@pytest.mark.asyncio
async def test_short_hls_download_is_retried_then_explained(monkeypatch, tmp_path):
    from app.services import downloader
    from app.services.download_errors import classify_download_error
    from app.services.downloader import PlaylistInfo

    url = "https://cdn.example.com/hls/720/index_287.m3u8"
    downloader._PLAYLIST_INFO[url] = PlaylistInfo(8785.8, [(0.0, url + "/s_0"), (8.09, url + "/s_1")])
    runs: list[int] = []
    diagnosed: list[str] = []

    async def fake_download(_url, destination, _headers, *_args, concurrency=4, **_kwargs):
        runs.append(concurrency)
        destination.write_bytes(b"ts" * 4096)
        return 0, "[download] 100%"

    async def eight_seconds(_path):
        return 8.008

    async def fake_diagnose(fragment_url, _headers):
        diagnosed.append(fragment_url)
        return "HTTP 200 text/html: an HTML page instead of video"

    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path))
    monkeypatch.setattr(VideoDownloader, "_download_via_ffmpeg", fake_download)
    monkeypatch.setattr(VideoDownloader, "_probe_media", eight_seconds)
    monkeypatch.setattr(downloader, "diagnose_fragment", fake_diagnose)

    with pytest.raises(ValueError) as caught:
        await VideoDownloader.download_source(
            job_id="job_short", media_url=url, media_type="hls", pre_resolved=True, required_seconds=11.042,
        )

    assert runs == [4, 1]  # one retry, one fragment at a time
    assert diagnosed == [url + "/s_1"]  # a fragment the file is missing
    message = str(caught.value)
    assert "0:08 of video from a 2:26:26 stream" in message and "HTML page" in message
    failure = classify_download_error(caught.value)
    assert failure.code == "SOURCE_INCOMPLETE" and failure.source_required
    assert "HTML page" in str(failure)
    assert not list(tmp_path.glob("job_short_source*"))


@pytest.mark.asyncio
async def test_complete_hls_download_is_not_retried(monkeypatch, tmp_path):
    from app.services import downloader
    from app.services.downloader import PlaylistInfo

    url = "https://cdn.example.com/hls/720/full.m3u8"
    downloader._PLAYLIST_INFO[url] = PlaylistInfo(8785.8, [(0.0, url + "/s_0")])
    runs: list[int] = []

    async def fake_download(_url, destination, _headers, *_args, concurrency=4, **_kwargs):
        runs.append(concurrency)
        destination.write_bytes(b"ts" * 4096)
        return 0, ""

    async def full_length(_path):
        return 8784.9

    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path))
    monkeypatch.setattr(VideoDownloader, "_download_via_ffmpeg", fake_download)
    monkeypatch.setattr(VideoDownloader, "_probe_media", full_length)

    path, duration = await VideoDownloader.download_source(
        job_id="job_full", media_url=url, media_type="hls", pre_resolved=True,
    )
    assert runs == [4] and duration == 8784.9 and path.exists()


@pytest.mark.asyncio
async def test_hls_length_is_the_sum_of_segments_not_target_duration():
    import m3u8
    from app.services.source_resolver import BackendSourceResolver

    media = m3u8.loads(PLAYLIST, uri="https://cdn.example.com/hls/720/index.m3u8")
    assert media.target_duration == 10
    assert await BackendSourceResolver._hls_duration(media, [], {}) == 28.091

    live = m3u8.loads(PLAYLIST.replace("#EXT-X-ENDLIST\n", ""), uri="https://cdn.example.com/live.m3u8")
    assert await BackendSourceResolver._hls_duration(live, [], {}) is None
