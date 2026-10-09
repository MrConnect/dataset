import pytest
from app.config import settings
from app.core.ssrf import validate_url_safety


def test_blocks_private_networks():
    settings.ALLOW_LOCAL_NETWORK = False

    # Private IPv4
    with pytest.raises(ValueError, match="anti-SSRF"):
        validate_url_safety("http://192.168.1.100/video.mp4")

    with pytest.raises(ValueError, match="anti-SSRF"):
        validate_url_safety("http://10.0.0.5/stream.m3u8")

    with pytest.raises(ValueError, match="anti-SSRF"):
        validate_url_safety("http://172.16.5.1/video.mpd")


def test_blocks_loopback_and_metadata():
    settings.ALLOW_LOCAL_NETWORK = False

    # Loopback
    with pytest.raises(ValueError, match="anti-SSRF"):
        validate_url_safety("http://127.0.0.1:8000/api")

    # AWS/GCP/Azure instance metadata service
    with pytest.raises(ValueError, match="anti-SSRF"):
        validate_url_safety("http://169.254.169.254/latest/meta-data/")


def test_blocks_invalid_schemes():
    with pytest.raises(ValueError, match="Disallowed scheme"):
        validate_url_safety("file:///etc/passwd")

    with pytest.raises(ValueError, match="Disallowed scheme"):
        validate_url_safety("ftp://example.com/movie.mp4")

    with pytest.raises(ValueError, match="Disallowed scheme"):
        validate_url_safety("gopher://example.com")


def test_allows_public_https_domains():
    settings.ALLOW_LOCAL_NETWORK = False
    # Valid public domain
    try:
        validate_url_safety("https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4")
    except ValueError as e:
        pytest.fail(f"Safe public URL raised unexpected SSRF error: {e}")
