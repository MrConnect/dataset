import json
import subprocess
import asyncio
from urllib.parse import urlparse
import defusedxml.ElementTree as ET
import httpx
import m3u8

from app.config import settings
from app.core.ssrf import validate_url_safety
from app.schemas.source import SourceResolveResponse, VideoQualitySchema


class BackendSourceResolver:
    @staticmethod
    async def resolve(
        media_url: str,
        type_hint: str | None = None,
        page_url: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> SourceResolveResponse:
        # Step 1: Anti-SSRF Validation
        validate_url_safety(media_url)

        # Standard browser headers
        req_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        }
        if page_url:
            req_headers["Referer"] = page_url
        if headers:
            req_headers.update(headers)

        # Step 2: Determine source type
        detected_type = type_hint
        if not detected_type:
            clean_url = media_url.lower().split("?")[0]
            if clean_url.endswith(".m3u8") or ".m3u8" in media_url:
                detected_type = "hls"
            elif clean_url.endswith(".mpd") or ".mpd" in media_url:
                detected_type = "dash"
            else:
                detected_type = "mp4"

        qualities: list[VideoQualitySchema] = []
        duration: float | None = None
        status = "available"
        error_msg: str | None = None

        try:
            if detected_type == "hls":
                try:
                    qualities, duration = await BackendSourceResolver._resolve_hls(media_url, req_headers)
                except Exception as e:
                    # Fallback to MP4 if HLS fails (could be misidentified or blocked)
                    qualities, duration = await BackendSourceResolver._resolve_mp4(media_url, req_headers)
            elif detected_type == "dash":
                try:
                    qualities, duration = await BackendSourceResolver._resolve_dash(media_url, req_headers)
                except Exception as e:
                    qualities, duration = await BackendSourceResolver._resolve_mp4(media_url, req_headers)
            else:
                qualities, duration = await BackendSourceResolver._resolve_mp4(media_url, req_headers)
        except Exception as e:
            status = "requires_validation"
            error_msg = str(e)
            qualities = [VideoQualitySchema(height=720, label="Standard Stream (Unverified)")]

        return SourceResolveResponse(
            media_url=media_url,
            type=detected_type,
            duration_seconds=duration,
            qualities=qualities,
            status=status,
            error=error_msg,
        )

    @staticmethod
    async def _resolve_hls(media_url: str, headers: dict[str, str]) -> tuple[list[VideoQualitySchema], float | None]:
        async with httpx.AsyncClient(headers=headers, timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(media_url)
            resp.raise_for_status()
            # Validate final redirect destination against SSRF
            validate_url_safety(str(resp.url))
            content = resp.text

        playlist = m3u8.loads(content, uri=media_url)
        qualities: list[VideoQualitySchema] = []

        if playlist.is_variant:
            for pl in playlist.playlists:
                width, height = None, None
                if pl.stream_info.resolution:
                    width, height = pl.stream_info.resolution

                qualities.append(
                    VideoQualitySchema(
                        height=height,
                        width=width,
                        bandwidth=pl.stream_info.bandwidth,
                        codecs=pl.stream_info.codecs,
                        label=f"{height}p ({int(pl.stream_info.bandwidth/1000)}k)" if height else f"{int(pl.stream_info.bandwidth/1000)}k",
                        variant_url=pl.absolute_uri,
                    )
                )
            # Sort descending by height
            qualities.sort(key=lambda q: (q.height or 0, q.bandwidth or 0), reverse=True)
        else:
            # Media playlist single stream
            qualities = [VideoQualitySchema(height=720, label="Single HLS Stream", variant_url=media_url)]

        duration = playlist.target_duration
        return qualities, duration

    @staticmethod
    async def _resolve_dash(media_url: str, headers: dict[str, str]) -> tuple[list[VideoQualitySchema], float | None]:
        async with httpx.AsyncClient(headers=headers, timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(media_url)
            resp.raise_for_status()
            validate_url_safety(str(resp.url))
            content = resp.text

        root = ET.fromstring(content)
        qualities: list[VideoQualitySchema] = []

        # Find Representation elements inside AdaptationSet
        # Handle namespace if present
        for elem in root.iter():
            tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if tag == "Representation":
                mime = elem.attrib.get("mimeType", "")
                if "video" in mime or "width" in elem.attrib or "height" in elem.attrib:
                    height = int(elem.attrib["height"]) if "height" in elem.attrib else None
                    width = int(elem.attrib["width"]) if "width" in elem.attrib else None
                    bandwidth = int(elem.attrib["bandwidth"]) if "bandwidth" in elem.attrib else None
                    rep_id = elem.attrib.get("id")
                    codecs = elem.attrib.get("codecs")

                    qualities.append(
                        VideoQualitySchema(
                            height=height,
                            width=width,
                            bandwidth=bandwidth,
                            codecs=codecs,
                            representation_id=rep_id,
                            label=f"{height}p [{rep_id}]" if height else f"Representation {rep_id}",
                        )
                    )

        qualities.sort(key=lambda q: (q.height or 0, q.bandwidth or 0), reverse=True)
        if not qualities:
            qualities = [VideoQualitySchema(height=720, label="Default DASH Stream")]

        return qualities, None

    @staticmethod
    async def _resolve_mp4(media_url: str, headers: dict[str, str]) -> tuple[list[VideoQualitySchema], float | None]:
        # Probe using ffprobe safely with headers
        ua = headers.get("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
        other_headers = {k: v for k, v in headers.items() if k.lower() != "user-agent"}
        headers_str = "".join(f"{k}: {v}\r\n" for k, v in other_headers.items())
        
        cmd = [
            "ffprobe",
            "-v", "error",
            "-user_agent", ua,
            "-headers", headers_str,
            "-show_entries", "format=duration:stream=width,height,codec_name",
            "-of", "json",
            media_url,
        ]

        try:
            # ffprobe is a blocking process. Keep it off the ASGI event loop so
            # source discovery cannot starve health checks and dashboard APIs.
            res = await asyncio.to_thread(
                subprocess.run,
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=15,
            )
            if res.returncode == 0:
                data = json.loads(res.stdout)
                duration = float(data.get("format", {}).get("duration", 0)) or None
                video_stream = next((s for s in data.get("streams", []) if "width" in s), None)
                if video_stream:
                    h = video_stream.get("height")
                    w = video_stream.get("width")
                    c = video_stream.get("codec_name")
                    return [VideoQualitySchema(height=h, width=w, codecs=c, label=f"{h}p ({c})", variant_url=media_url)], duration
        except Exception:
            pass

        # Default fallback qualities for direct MP4
        return [
            VideoQualitySchema(height=1080, label="1080p (Original)", variant_url=media_url),
            VideoQualitySchema(height=720, label="720p (HD)", variant_url=media_url),
            VideoQualitySchema(height=480, label="480p (SD)", variant_url=media_url),
        ], None
