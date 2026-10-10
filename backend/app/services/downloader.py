import asyncio
import json
import os
from pathlib import Path
import re
import subprocess
import httpx

from app.config import settings
from app.core.ssrf import validate_url_safety


def _run_subprocess_sync(cmd: list[str], timeout: float | None = None) -> tuple[int, str, str]:
    """
    Executes a subprocess synchronously. Used via asyncio.to_thread to ensure
    100% compatibility across Windows, Linux, and Docker without asyncio NotImplementedError.
    """
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        return (
            proc.returncode,
            proc.stdout.decode("utf-8", errors="replace"),
            proc.stderr.decode("utf-8", errors="replace"),
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"Process timed out after {timeout} seconds") from exc


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

            async with httpx.AsyncClient(headers=req_headers, timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(page_url)
                if resp.status_code != 200:
                    return None
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
        except Exception as e:
            print(f"[StreamExtractor] Failed to extract from {page_url}: {e}")
            return None, headers

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
            from urllib.parse import urljoin
            req_headers = dict(headers)
            async with httpx.AsyncClient(headers=req_headers, timeout=10.0, follow_redirects=True) as client:
                r = await client.get(m3u8_url)
                if r.status_code != 200 or "#EXT-X-STREAM-INF" not in r.text:
                    return m3u8_url

                lines = r.text.splitlines()
                variants: list[tuple[int, str]] = []
                current_height = 0
                for line in lines:
                    line = line.strip()
                    if line.startswith("#EXT-X-STREAM-INF"):
                        res_match = re.search(r"RESOLUTION=\d+x(\d+)", line)
                        if res_match:
                            current_height = int(res_match.group(1))
                        else:
                            bw_match = re.search(r"BANDWIDTH=(\d+)", line)
                            current_height = int(bw_match.group(1)) if bw_match else 0
                    elif line and not line.startswith("#"):
                        variant_full_url = urljoin(m3u8_url, line)
                        variants.append((current_height, variant_full_url))
                        current_height = 0

                if not variants:
                    return m3u8_url

                if target_height:
                    variants.sort(key=lambda v: abs(v[0] - target_height))
                    selected = variants[0][1]
                else:
                    variants.sort(key=lambda v: v[0], reverse=True)
                    selected = variants[0][1]

                print(f"[StreamExtractor] Resolved master playlist -> variant: {selected[:80]}...")
                return selected
        except Exception as e:
            print(f"[StreamExtractor] Failed to resolve master playlist variant: {e}")
            return m3u8_url


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
        validate_url_safety(target_url)

        req_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        }
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
                print(f"[VideoDownloader] Resolved embed URL {target_url} -> {resolved_stream}")
                req_headers.update(resolved_headers)
                req_headers["Referer"] = target_url
                target_url = resolved_stream
                validate_url_safety(target_url)
                if ".m3u8" in target_url:
                    media_type = "hls"
                elif ".mpd" in target_url:
                    media_type = "dash"
                elif ".mp4" in target_url:
                    media_type = "mp4"

        # If HLS, ensure we target the specific variant playlist instead of multi-variant master
        if media_type == "hls" or ".m3u8" in target_url:
            target_url = await StreamExtractor.resolve_best_variant_url(target_url, req_headers, target_height)

        return target_url, media_type, req_headers

    @staticmethod
    async def download_source(
        job_id: str,
        media_url: str,
        media_type: str,
        variant_url: str | None = None,
        headers: dict[str, str] | None = None,
        duration_seconds: float | None = None,
        progress_callback = None,
    ) -> tuple[Path, float]:
        """
        Downloads the source video once per job into temporary storage.
        Validates anti-SSRF, download limits, and checks integrity with FFprobe.
        """
        target_url, media_type, req_headers = await VideoDownloader.resolve_stream(
            media_url=media_url,
            media_type=media_type,
            variant_url=variant_url,
            headers=headers,
        )

        is_hls = media_type == "hls" or ".m3u8" in target_url.lower()
        is_dash = media_type == "dash" or ".mpd" in target_url.lower()

        # Keep HLS in its native MPEG-TS container. Remuxing long HLS streams
        # yt-dlp natively fixes and merges HLS segments perfectly into MP4 containers.
        output_file = settings.temp_path / f"{job_id}_source.mp4"

        if is_hls or is_dash:
            await VideoDownloader._download_via_ffmpeg(
                target_url,
                output_file,
                req_headers,
                duration_seconds,
                progress_callback,
                is_hls=is_hls,
            )
        else:
            await VideoDownloader._download_direct_http(target_url, output_file, req_headers, progress_callback)

        # Post-download verification using FFprobe
        duration = await VideoDownloader._probe_media(output_file)
        return output_file, duration

    @staticmethod
    async def _download_direct_http(url: str, destination: Path, headers: dict[str, str], progress_callback = None) -> None:
        async with httpx.AsyncClient(headers=headers, timeout=settings.DOWNLOAD_TIMEOUT_SECONDS, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                validate_url_safety(str(resp.url))

                total_bytes = 0
                max_bytes = settings.MAX_DOWNLOAD_SIZE_BYTES
                
                content_length_str = resp.headers.get('Content-Length')
                content_length = int(content_length_str) if content_length_str and content_length_str.isdigit() else None
                
                last_reported_pct = -1

                with open(destination, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        total_bytes += len(chunk)
                        if total_bytes > max_bytes:
                            destination.unlink(missing_ok=True)
                            raise ValueError(
                                f"Downloaded file exceeded maximum allowed size of {settings.MAX_DOWNLOAD_SIZE_BYTES} bytes"
                            )
                        f.write(chunk)
                        
                        if progress_callback and content_length:
                            pct = min(100, int((total_bytes / content_length) * 100))
                            if pct > last_reported_pct:
                                await progress_callback(pct)
                                last_reported_pct = pct

    @staticmethod
    async def _download_via_ffmpeg(url: str, destination: Path, headers: dict[str, str], duration_seconds: float | None = None, progress_callback = None, is_hls: bool = False) -> None:
        import re
        ua = headers.get("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
        
        if is_hls:
            cmd = [
                "yt-dlp",
                "--hls-prefer-native",
                "--concurrent-fragments", "4",
                "--retries", "10",
                "--fragment-retries", "10",
                "--retry-sleep", "fragment:exp=1:20",
                "--merge-output-format", "mp4",
                "--remux-video", "mp4",
                "--user-agent", ua,
                "--no-warnings"
            ]
            for k, v in headers.items():
                if k.lower() != "user-agent":
                    cmd.extend(["--add-header", f"{k}:{v}"])
            cmd.extend(["-o", str(destination), url])
        else:
            headers_list = [f"{k}: {v}" for k, v in headers.items() if k.lower() != "user-agent"]
            if "Origin" not in headers and "Referer" in headers:
                ref = headers["Referer"]
                origin = "/".join(ref.split("/")[:3])
                headers_list.append(f"Origin: {origin}")
            headers_str = "".join(f"{h}\r\n" for h in headers_list)
            
            cmd = [
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

        import asyncio
        from collections import deque
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        
        # Basic progress monitoring parsing ffmpeg/yt-dlp output
        error_log = deque(maxlen=20)
        last_pct = -1
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                line_str = line.decode(errors='replace').strip()
                if line_str:
                    error_log.append(line_str)
                    if progress_callback and duration_seconds and not is_hls:
                        m = re.search(r"time=(\d{2}):(\d{2}):(\d{2}\.\d{2})", line_str)
                        if m:
                            h, m_m, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                            curr = h * 3600 + m_m * 60 + s
                            pct = min(100, int((curr / duration_seconds) * 100))
                            if pct > last_pct:
                                await progress_callback(pct)
                                last_pct = pct
                    elif progress_callback and is_hls:
                        # yt-dlp progress: [download]  50.0% of ~2.50GiB
                        m = re.search(r"\[download\]\s+(\d+\.?\d*)%(?:.*?frag|.*?MiB|.*?GiB)", line_str)
                        if m:
                            pct = min(100, int(float(m.group(1))))
                            if pct > last_pct or (last_pct - pct) > 50:
                                await progress_callback(pct)
                                last_pct = pct

            await asyncio.wait_for(process.wait(), timeout=settings.MAX_DURATION_SECONDS)
        except asyncio.TimeoutError:
            process.kill()
            destination.unlink(missing_ok=True)
            raise TimeoutError("FFmpeg/yt-dlp stream download timed out.")
            
        if process.returncode != 0 and not destination.exists():
            err_output = "\n".join(error_log)
            raise RuntimeError(f"FFmpeg/yt-dlp download failed (code {process.returncode}):\n{err_output}")

    @staticmethod
    async def _probe_media(file_path: Path) -> float:
        """
        Validates media integrity using FFprobe and returns duration in seconds.
        """
        if not file_path.exists() or file_path.stat().st_size < 4096:
            raise FileNotFoundError(f"Downloaded media file '{file_path}' does not exist or is empty.")

        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "format=duration,size:stream=codec_type,duration,start_time,width,height",
            "-of", "json",
            str(file_path),
        ]

        returncode, stdout, stderr = await asyncio.to_thread(_run_subprocess_sync, cmd, 30.0)
        if returncode != 0:
            raise ValueError(
                f"FFprobe media validation failed: {stderr}"
            )

        try:
            data = json.loads(stdout)
            streams = data.get("streams", [])
            if not streams:
                raise ValueError("Downloaded source has no playable video stream")
            video_stream = streams[0]
            if not video_stream.get("width") or not video_stream.get("height"):
                raise ValueError("Downloaded source video stream has invalid dimensions")
            stream_duration = video_stream.get("duration")
            format_duration = data.get("format", {}).get("duration")
            try:
                duration = float(stream_duration)
            except (TypeError, ValueError):
                duration = float(format_duration or 0)
            if duration <= 0:
                raise ValueError("Downloaded source has no measurable video duration")
            return duration
        except Exception as e:
            raise ValueError(f"Could not parse media duration from FFprobe: {e}")
