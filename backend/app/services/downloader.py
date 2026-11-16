import asyncio
import logging
import re
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urljoin

import httpx

from app.config import settings
from app.core.ssrf import SSRFBlocked, guarded_client, validate_url_safety_async
from app.services.media_probe import probe_video, run_subprocess_sync

logger = logging.getLogger("downloader")

# Kept under the old name: the video processor imports it from here.
_run_subprocess_sync = run_subprocess_sync

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)

ProgressCallback = Callable[[int], Awaitable[None]]
CancelCheck = Callable[[], bool]


@dataclass
class PlaylistInfo:
    """What a media playlist promises: total length and where each fragment starts."""
    total_seconds: float
    fragments: list[tuple[float, str]]  # (start time, absolute URL)


# Filled when the media playlist is fetched during resolution, keyed by its
# URL, so the download can be checked against it without fetching it again.
_PLAYLIST_INFO: dict[str, PlaylistInfo] = {}


def parse_media_playlist(playlist_url: str, text: str) -> PlaylistInfo | None:
    """Total duration and fragment list of a complete (ENDLIST) media playlist."""
    if "#EXT-X-ENDLIST" not in text:
        return None  # live or sliding window: no fixed length to compare with
    fragments: list[tuple[float, str]] = []
    position = 0.0
    pending: float | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXTINF:"):
            try:
                pending = float(line[8:].split(",", 1)[0])
            except ValueError:
                pending = None
        elif line and not line.startswith("#") and pending is not None:
            fragments.append((position, urljoin(playlist_url, line)))
            position += pending
            pending = None
    return PlaylistInfo(position, fragments) if fragments else None


def _looks_like_media(head: bytes) -> bool:
    if len(head) > 376 and head[0] == 0x47 and head[188] == 0x47 and head[376] == 0x47:
        return True  # MPEG-TS
    return b"ftyp" in head[:16] or b"moof" in head[:64]  # fragmented MP4


async def diagnose_fragment(url: str, headers: dict[str, str]) -> str:
    """Fetch the start of one fragment with the job's headers and describe the answer."""
    try:
        async with guarded_client(headers={**headers, "Range": "bytes=0-4095"}, timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            head = response.content[:4096]
    except Exception as exc:  # network errors are the diagnosis
        return f"the request failed ({type(exc).__name__}: {exc})"
    content_type = response.headers.get("content-type", "unknown type")
    if _looks_like_media(head):
        return f"HTTP {response.status_code} {content_type}, real video data"
    text = head[:200].decode("utf-8", errors="replace").strip().lower()
    if text.startswith("<!doctype") or text.startswith("<html") or "<html" in text:
        what = "an HTML page instead of video (the CDN refuses the server: blocked IP, hotlink protection or a bot check)"
    elif not head:
        what = "an empty body"
    else:
        what = "data that is not video"
    return f"HTTP {response.status_code} {content_type}: {what}"


def _clock(seconds: float) -> str:
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


class DownloadCancelled(Exception):
    """The owning job was cancelled while its source was downloading."""


def remove_partial_downloads(destination: Path) -> None:
    """Remove a download target together with yt-dlp's .part/.ytdl/fragment files."""
    for leftover in destination.parent.glob(f"{destination.name}*"):
        try:
            if leftover.is_file():
                leftover.unlink()
        except OSError:
            pass


def _bytes_on_disk(destination: Path) -> int:
    total = 0
    for item in destination.parent.glob(f"{destination.name}*"):
        try:
            total += item.stat().st_size
        except OSError:
            pass
    return total


class StreamExtractor:
    """
    Extracts raw media streams (.m3u8, .mpd, .mp4) from embed web pages
    (VidTube, Streamwish, Dood, JWPlayer Dean Edwards packed scripts).
    """

    @staticmethod
    def unpack_dean_edwards(packed_code: str) -> str:
        pattern = r"return\s+p}\s*\(\s*['\"](.*?)['\"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['\"](.*?)['\"]\.split\('\|'\)"
        match = re.search(pattern, packed_code, re.DOTALL)
        if not match:
            # Fallback to broader match if return p is not present
            fallback = r"}\s*\(\s*['\"](.*?)['\"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['\"](.*?)['\"]\.split\('\|'\)"
            match = re.search(fallback, packed_code, re.DOTALL)
            if not match:
                return ""

        payload = match.group(1)
        radix = int(match.group(2))
        count = int(match.group(3))
        words = match.group(4).split("|")

        alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

        def base_n(num: int, b: int) -> str:
            if num == 0:
                return alphabet[0]
            res = ""
            while num > 0:
                res = alphabet[num % b] + res
                num //= b
            return res

        lookup = {}
        for i in range(count):
            key = base_n(i, radix)
            if i < len(words) and words[i]:
                lookup[key] = words[i]

        return re.sub(r"\b\w+\b", lambda m: lookup.get(m.group(0), m.group(0)), payload)

    @staticmethod
    async def extract_from_html_page(page_url: str, headers: dict[str, str]) -> tuple[str | None, dict[str, str]]:
        """
        Extracts stream URL and required headers from embed HTML page.
        Returns (stream_url, headers_dict).
        """
        try:
            req_headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            }
            req_headers.update(headers)
            if "Referer" not in req_headers:
                req_headers["Referer"] = page_url

            async with guarded_client(headers=req_headers, timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(page_url)
                if resp.status_code != 200:
                    return None, req_headers
                html = resp.text

            # 1. Look for packed Dean Edwards eval scripts
            eval_blocks = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?split\('\|'\)\)\)", html, re.DOTALL)
            for packed in eval_blocks:
                unpacked = StreamExtractor.unpack_dean_edwards(packed)
                m3u8_matches = re.findall(r'https?://[^\s"\'\\]+?\.m3u8[^\s"\'\\]*', unpacked)
                if m3u8_matches:
                    return m3u8_matches[0], req_headers
                mp4_matches = re.findall(r'https?://[^\s"\'\\]+?\.mp4[^\s"\'\\]*', unpacked)
                if mp4_matches:
                    return mp4_matches[0], req_headers

            # 2. Look for direct m3u8 in raw HTML
            direct_m3u8 = re.findall(r'https?://[^\s"\'\\]+?\.m3u8[^\s"\'\\]*', html)
            if direct_m3u8:
                return direct_m3u8[0], req_headers

            # 3. Look for direct mp4 in raw HTML
            direct_mp4 = re.findall(r'https?://[^\s"\'\\]+?\.mp4[^\s"\'\\]*', html)
            if direct_mp4:
                return direct_mp4[0], req_headers

            # 4. Look for MPD
            direct_mpd = re.findall(r'https?://[^\s"\'\\]+?\.mpd[^\s"\'\\]*', html)
            if direct_mpd:
                return direct_mpd[0], req_headers

            return None, req_headers
        except SSRFBlocked:
            raise
        except Exception as e:
            logger.info("Failed to extract stream from %s: %s", page_url[:80], e)
            return None, headers

    @staticmethod
    async def _validate_playlist_hosts(playlist_url: str, playlist_text: str) -> None:
        """Reject a media playlist whose segments/keys point at internal hosts.

        Uses text that was already fetched, so it costs no extra request
        against sources with single-use or IP-bound tokens.
        """
        hosts: dict[str, str] = {}
        for raw in playlist_text.splitlines():
            line = raw.strip()
            if not line:
                continue
            candidates: list[str] = []
            if line.startswith("#"):
                candidates.extend(re.findall(r'URI="([^"]+)"', line))
            else:
                candidates.append(line)
            for candidate in candidates:
                absolute = urljoin(playlist_url, candidate)
                match = re.match(r"^(https?)://([^/?#]+)", absolute, re.IGNORECASE)
                if match:
                    hosts.setdefault(match.group(2).lower(), absolute)
                elif re.match(r"^[a-z][a-z0-9+.\-]*:", absolute, re.IGNORECASE) and not absolute.lower().startswith("data:"):
                    raise ValueError(f"Playlist references a disallowed URL scheme: {absolute[:60]}")
        for sample_url in hosts.values():
            await validate_url_safety_async(sample_url)

    @staticmethod
    async def resolve_best_variant_url(
        m3u8_url: str,
        headers: dict[str, str],
        target_height: int | None = None
    ) -> str:
        """
        If m3u8_url is a master playlist, fetches it and resolves the single variant URL.
        This prevents FFmpeg from opening all variants concurrently, which causes CDN 403 Forbidden.
        """
        try:
            req_headers = dict(headers)
            async with guarded_client(headers=req_headers, timeout=10.0, follow_redirects=True) as client:
                r = await client.get(m3u8_url)
                if r.status_code != 200:
                    return m3u8_url
                playlist_text = r.text
        except SSRFBlocked:
            raise
        except Exception as e:
            logger.info("Failed to resolve master playlist variant: %s", e)
            return m3u8_url

        if "#EXT-X-STREAM-INF" not in playlist_text:
            if "#EXTM3U" in playlist_text:
                # A blocked host here is a policy decision, not a network
                # hiccup, so it must not be swallowed like the errors above.
                await StreamExtractor._validate_playlist_hosts(m3u8_url, playlist_text)
                info = parse_media_playlist(m3u8_url, playlist_text)
                if info is not None:
                    _PLAYLIST_INFO[m3u8_url] = info
            return m3u8_url

        variants: list[tuple[int, str]] = []
        current_height = 0
        for line in playlist_text.splitlines():
            line = line.strip()
            if line.startswith("#EXT-X-STREAM-INF"):
                res_match = re.search(r"RESOLUTION=\d+x(\d+)", line)
                if res_match:
                    current_height = int(res_match.group(1))
                else:
                    bw_match = re.search(r"BANDWIDTH=(\d+)", line)
                    current_height = int(bw_match.group(1)) if bw_match else 0
            elif line and not line.startswith("#"):
                variants.append((current_height, urljoin(m3u8_url, line)))
                current_height = 0

        if not variants:
            return m3u8_url

        if target_height:
            variants.sort(key=lambda v: abs(v[0] - target_height))
        else:
            variants.sort(key=lambda v: v[0], reverse=True)
        selected = variants[0][1]
        logger.info("Resolved master playlist -> variant: %s...", selected[:80])
        return selected


class VideoDownloader:
    @staticmethod
    async def resolve_stream(
        media_url: str,
        media_type: str,
        variant_url: str | None = None,
        headers: dict[str, str] | None = None,
        target_height: int | None = None,
    ) -> tuple[str, str, dict[str, str]]:
        """
        Resolves media URL and headers, unpacking embed pages if needed.
        Returns (resolved_url, media_type, req_headers).
        """
        target_url = variant_url or media_url
        await validate_url_safety_async(target_url)

        req_headers = {"User-Agent": DEFAULT_USER_AGENT}
        if headers:
            req_headers.update(headers)

        clean_target = target_url.lower().split("?")[0]
        is_html_page = (
            clean_target.endswith(".html")
            or clean_target.endswith(".htm")
            or clean_target.endswith(".php")
            or "embed" in target_url
            or "watch" in target_url
        ) and not (clean_target.endswith(".m3u8") or clean_target.endswith(".mp4") or clean_target.endswith(".mpd"))

        if is_html_page:
            resolved_stream, resolved_headers = await StreamExtractor.extract_from_html_page(target_url, req_headers)
            if resolved_stream:
                logger.info("Resolved embed URL %s -> %s", target_url[:80], resolved_stream[:80])
                req_headers.update(resolved_headers)
                req_headers["Referer"] = target_url
                target_url = resolved_stream
                await validate_url_safety_async(target_url)
                if ".m3u8" in target_url:
                    media_type = "hls"
                elif ".mpd" in target_url:
                    media_type = "dash"
                elif ".mp4" in target_url:
                    media_type = "mp4"

        # If HLS, ensure we target the specific variant playlist instead of multi-variant master
        if media_type == "hls" or ".m3u8" in target_url:
            target_url = await StreamExtractor.resolve_best_variant_url(target_url, req_headers, target_height)
            await validate_url_safety_async(target_url)

        return target_url, media_type, req_headers

    @staticmethod
    async def download_source(
        job_id: str,
        media_url: str,
        media_type: str,
        variant_url: str | None = None,
        headers: dict[str, str] | None = None,
        duration_seconds: float | None = None,
        progress_callback: ProgressCallback | None = None,
        target_height: int | None = None,
        *,
        pre_resolved: bool = False,
        required_seconds: float | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> tuple[Path, float]:
        """
        Downloads the source video once per job into temporary storage.

        ``pre_resolved`` skips stream resolution when the caller already ran
        ``resolve_stream`` (resolving twice re-fetches embed pages and
        playlists, which burns single-use tokens).

        ``required_seconds`` is the furthest timestamp any segment needs. A
        download tool that exits with an error is only tolerated when the
        file it left behind still covers that point.
        """
        if pre_resolved:
            target_url, req_headers = variant_url or media_url, dict(headers or {})
        else:
            target_url, media_type, req_headers = await VideoDownloader.resolve_stream(
                media_url=media_url,
                media_type=media_type,
                variant_url=variant_url,
                headers=headers,
                target_height=target_height,
            )

        is_hls = media_type == "hls" or ".m3u8" in target_url.lower()
        is_dash = media_type == "dash" or ".mpd" in target_url.lower()

        # Keep HLS in its native MPEG-TS timeline. Remuxing a long playlist to
        # MP4 can rewrite discontinuities/edit timestamps and make browser
        # currentTime ranges land on different source frames.
        output_suffix = ".ts" if is_hls else ".mp4"
        output_file = settings.temp_path / f"{job_id}_source{output_suffix}"
        remove_partial_downloads(output_file)

        returncode, tool_log = 0, ""
        playlist = _PLAYLIST_INFO.pop(target_url, None) if is_hls else None
        try:
            if is_hls or is_dash:
                result = await VideoDownloader._download_via_ffmpeg(
                    target_url,
                    output_file,
                    req_headers,
                    duration_seconds,
                    progress_callback,
                    is_hls=is_hls,
                    target_height=target_height,
                    should_cancel=should_cancel,
                )
                if result is not None:
                    returncode, tool_log = result
            else:
                await VideoDownloader._download_direct_http(
                    target_url, output_file, req_headers, progress_callback, should_cancel
                )

            if returncode != 0 and not output_file.exists():
                raise RuntimeError(f"FFmpeg/yt-dlp download failed (code {returncode}):\n{tool_log}")

            # Post-download verification using FFprobe
            try:
                duration = await VideoDownloader._probe_media(output_file)
            except Exception as probe_error:
                if returncode != 0:
                    # Surface the tool's own error (403, timeout, ...) so it is
                    # classified correctly instead of as a generic probe failure.
                    raise RuntimeError(
                        f"FFmpeg/yt-dlp download failed (code {returncode}):\n{tool_log}"
                    ) from probe_error
                raise

            if playlist is not None and VideoDownloader._is_short(duration, playlist.total_seconds):
                logger.warning(
                    "Job %s: got %.1fs of a %.1fs playlist; retrying one fragment at a time",
                    job_id, duration, playlist.total_seconds,
                )
                remove_partial_downloads(output_file)
                result = await VideoDownloader._download_via_ffmpeg(
                    target_url, output_file, req_headers, duration_seconds, progress_callback,
                    is_hls=True, target_height=target_height, should_cancel=should_cancel, concurrency=1,
                )
                returncode, tool_log = result if result is not None else (0, "")
                duration = await VideoDownloader._probe_media(output_file) if output_file.exists() else 0.0
                if VideoDownloader._is_short(duration, playlist.total_seconds):
                    # Ask the CDN for a fragment the file is missing and say what came back.
                    missing = next(
                        (url for start, url in playlist.fragments if start > duration + 1),
                        playlist.fragments[-1][1],
                    )
                    diagnosis = await diagnose_fragment(missing, req_headers)
                    logger.warning("Job %s: incomplete HLS download; missing fragment answered: %s", job_id, diagnosis)
                    raise ValueError(
                        "Downloaded source is incomplete or mismatched: the server received "
                        f"{_clock(duration)} of video from a {_clock(playlist.total_seconds)} stream. "
                        f"A missing segment requested by the server returned {diagnosis}. "
                        "The stream plays in your browser, so upload the video to continue."
                    )

            if returncode != 0:
                needed = required_seconds or duration_seconds
                if needed is None or duration + 0.5 < needed:
                    covered = f"{int(duration)}s"
                    wanted = f"{int(needed)}s" if needed is not None else "an unknown length"
                    raise ValueError(
                        "Downloaded source is incomplete or mismatched: the download stopped early "
                        f"(exit code {returncode}) with {covered} of video, but {wanted} is required."
                    )
                logger.warning(
                    "Job %s: download tool exited with code %s but the file covers every segment; continuing.",
                    job_id, returncode,
                )
            return output_file, duration
        except BaseException:
            remove_partial_downloads(output_file)
            raise

    @staticmethod
    async def _download_direct_http(
        url: str,
        destination: Path,
        headers: dict[str, str],
        progress_callback: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> None:
        deadline = time.monotonic() + settings.MAX_DURATION_SECONDS
        # connect/read/write timeouts apply per operation, so a silent peer is
        # dropped after the stall timeout instead of holding the worker.
        timeout = httpx.Timeout(settings.DOWNLOAD_STALL_TIMEOUT_SECONDS, connect=30.0)
        async with guarded_client(headers=headers, timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()

                total_bytes = 0
                max_bytes = settings.MAX_DOWNLOAD_SIZE_BYTES

                content_length_str = resp.headers.get('Content-Length')
                content_length = int(content_length_str) if content_length_str and content_length_str.isdigit() else None
                if content_length is not None and content_length > max_bytes:
                    raise ValueError(
                        f"Source file is {content_length} bytes, above the maximum allowed size of {max_bytes} bytes"
                    )

                last_reported_pct = -1

                with open(destination, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        if should_cancel and should_cancel():
                            raise DownloadCancelled()
                        if time.monotonic() > deadline:
                            raise TimeoutError("Source download timed out.")
                        total_bytes += len(chunk)
                        if total_bytes > max_bytes:
                            raise ValueError(
                                f"Downloaded file exceeded maximum allowed size of {max_bytes} bytes"
                            )
                        f.write(chunk)

                        if progress_callback and content_length:
                            pct = min(100, int((total_bytes / content_length) * 100))
                            if pct > last_reported_pct:
                                await progress_callback(pct)
                                last_reported_pct = pct

                if content_length is not None and total_bytes < content_length:
                    raise ValueError(
                        "Downloaded source is incomplete or mismatched: "
                        f"received {total_bytes} of {content_length} bytes."
                    )

    @staticmethod
    def _is_short(duration: float, expected: float) -> bool:
        """More than a rounding difference shorter than the playlist promised."""
        return duration < expected - max(10.0, expected * 0.02)

    @staticmethod
    def _build_download_command(
        url: str,
        destination: Path,
        headers: dict[str, str],
        is_hls: bool,
        target_height: int | None,
        concurrency: int = 4,
    ) -> list[str]:
        ua = headers.get("User-Agent", DEFAULT_USER_AGENT)

        if is_hls:
            cmd = [
                "yt-dlp",
                "--newline",
                "--hls-prefer-native",
                "--hls-use-mpegts",
                "--concurrent-fragments", str(concurrency),
                "--retries", "10",
                "--fragment-retries", "10",
                "--retry-sleep", "fragment:exp=1:20",
                # Without this yt-dlp skips fragments it could not fetch and
                # still exits 0, silently producing a video with holes.
                "--abort-on-unavailable-fragments",
                "--socket-timeout", "30",
            ]
            if target_height:
                cmd.extend(["-S", f"res:{target_height}"])

            cmd.extend(["--user-agent", ua, "--no-warnings"])
            for k, v in headers.items():
                if k.lower() != "user-agent":
                    cmd.extend(["--add-header", f"{k}:{v}"])
            cmd.extend(["-o", str(destination), url])
            return cmd

        headers_list = [f"{k}: {v}" for k, v in headers.items() if k.lower() != "user-agent"]
        if "Origin" not in headers and "Referer" in headers:
            ref = headers["Referer"]
            origin = "/".join(ref.split("/")[:3])
            headers_list.append(f"Origin: {origin}")
        headers_str = "".join(f"{h}\r\n" for h in headers_list)

        return [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-v", "info",
            "-user_agent", ua,
            "-headers", headers_str,
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_on_network_error", "1",
            "-reconnect_on_http_error", "408,429,5xx",
            "-reconnect_delay_max", "10",
            "-i", url,
            "-c", "copy",
            str(destination)
        ]

    @staticmethod
    async def _download_via_ffmpeg(
        url: str,
        destination: Path,
        headers: dict[str, str],
        duration_seconds: float | None = None,
        progress_callback: ProgressCallback | None = None,
        is_hls: bool = False,
        target_height: int | None = None,
        should_cancel: CancelCheck | None = None,
        concurrency: int = 4,
    ) -> tuple[int, str]:
        """Run yt-dlp (HLS) or ffmpeg (DASH) and supervise it.

        Returns ``(returncode, last_log_lines)``. The process is killed, and an
        exception raised, when the job is cancelled, the overall deadline
        passes, nothing happens for the stall timeout, or the bytes on disk
        exceed the size limit.
        """
        cmd = VideoDownloader._build_download_command(url, destination, headers, is_hls, target_height, concurrency)

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=10485760,
        )

        error_log: deque[str] = deque(maxlen=20)
        last_pct = -1
        started = time.monotonic()
        last_activity = started
        last_size_check = 0.0
        last_size = 0
        buffer = b""

        async def handle_line(line_str: str) -> None:
            nonlocal last_pct
            error_log.append(line_str)
            if not progress_callback:
                return
            if is_hls:
                # yt-dlp progress: [download]  50.0% of ~2.50GiB
                m = re.search(r"\[download\]\s+(\d+\.?\d*)%(?:.*?frag|.*?MiB|.*?GiB)", line_str)
                if m:
                    pct = min(100, int(float(m.group(1))))
                    if pct > last_pct or (last_pct - pct) > 50:
                        await progress_callback(pct)
                        last_pct = pct
            elif duration_seconds:
                m = re.search(r"time=(\d{2}):(\d{2}):(\d{2}\.\d{2})", line_str)
                if m:
                    curr = float(m.group(1)) * 3600 + float(m.group(2)) * 60 + float(m.group(3))
                    pct = min(100, int((curr / duration_seconds) * 100))
                    if pct > last_pct:
                        await progress_callback(pct)
                        last_pct = pct

        async def abort(error: BaseException) -> None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=10)
            except Exception:
                pass
            remove_partial_downloads(destination)
            raise error

        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(process.stdout.read(4096), timeout=1.0)
                except asyncio.TimeoutError:
                    chunk = None

                now = time.monotonic()
                if chunk == b"":
                    break
                if chunk:
                    last_activity = now
                    buffer += chunk
                    # Lines are separated by \r (progress redraws) or \n.
                    while True:
                        match = re.search(b"[\r\n]", buffer)
                        if not match:
                            if len(buffer) > 10485760:
                                buffer = buffer[-4096:]
                            break
                        line_str = buffer[:match.start()].decode(errors="replace").strip()
                        buffer = buffer[match.start() + 1:]
                        if line_str:
                            await handle_line(line_str)

                if should_cancel and should_cancel():
                    await abort(DownloadCancelled())

                if now - started > settings.MAX_DURATION_SECONDS:
                    await abort(TimeoutError("FFmpeg/yt-dlp stream download timed out."))

                if now - last_size_check >= 2.0:
                    last_size_check = now
                    size = await asyncio.to_thread(_bytes_on_disk, destination)
                    if size != last_size:
                        last_size = size
                        last_activity = now
                    if size > settings.MAX_DOWNLOAD_SIZE_BYTES:
                        await abort(ValueError(
                            f"Downloaded file exceeded maximum allowed size of {settings.MAX_DOWNLOAD_SIZE_BYTES} bytes"
                        ))

                if now - last_activity > settings.DOWNLOAD_STALL_TIMEOUT_SECONDS:
                    await abort(TimeoutError(
                        f"Source download timed out: no progress for {settings.DOWNLOAD_STALL_TIMEOUT_SECONDS} seconds."
                    ))

            try:
                await asyncio.wait_for(process.wait(), timeout=30)
            except asyncio.TimeoutError:
                await abort(TimeoutError("FFmpeg/yt-dlp stream download timed out while finishing."))
        except asyncio.CancelledError:
            # Server shutdown: do not leave an orphaned downloader running.
            try:
                process.kill()
            except ProcessLookupError:
                pass
            raise

        return process.returncode or 0, "\n".join(error_log)

    @staticmethod
    async def _probe_media(file_path: Path) -> float:
        """
        Validates media integrity using FFprobe and returns duration in seconds.
        """
        try:
            info = await probe_video(file_path)
        except FileNotFoundError:
            raise
        except Exception as e:
            raise ValueError(f"FFprobe could not validate the downloaded media: {e}")
        return info.duration
