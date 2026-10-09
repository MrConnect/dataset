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
            text=True,
            timeout=timeout,
            encoding='utf-8',
            errors='replace'
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return -1, e.stdout.decode() if e.stdout else "", f"Command timed out after {timeout}s: {e.stderr.decode() if e.stderr else ''}"
    except Exception as e:
        return -1, "", str(e)


class VideoDownloader:
    @staticmethod
    async def download_source(
        target_url: str,
        job_id: str,
        media_type: str,
        headers: dict[str, str],
        duration_seconds: float | None = None,
        progress_callback = None
    ) -> tuple[Path, float]:
        """
        Downloads the source video exactly once to a temporary file, bypassing simple IP checks.
        Returns the (local_path, actual_duration).
        """
        validate_url_safety(target_url)

        # Output to .mp4 always, yt-dlp will handle container correctly
        output_file = settings.temp_path / f"{job_id}_source.mp4"

        if media_type in ("hls", "dash") or target_url.endswith(".m3u8") or ".m3u8" in target_url or ".mpd" in target_url:
            await VideoDownloader._download_via_ffmpeg(target_url, output_file, headers, duration_seconds, progress_callback, is_hls=True)
        else:
            await VideoDownloader._download_direct_http(target_url, output_file, headers, progress_callback)

        # Post-download verification using FFprobe
        duration = await VideoDownloader._probe_media(output_file)
        return output_file, duration

    @staticmethod
    async def _download_direct_http(url: str, destination: Path, headers: dict[str, str], progress_callback = None) -> None:
        async with httpx.AsyncClient(headers=headers, timeout=settings.DOWNLOAD_TIMEOUT_SECONDS, follow_redirects=True) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                total = int(response.headers.get("Content-Length", 0))
                downloaded = 0
                last_reported_pct = -1

                with open(destination, "wb") as f:
                    async for chunk in response.aiter_bytes():
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total > 0 and progress_callback:
                            pct = int((downloaded / total) * 100)
                            if pct % 5 == 0 and pct != last_reported_pct:
                                await progress_callback(pct)
                                last_reported_pct = pct

    @staticmethod
    async def _download_via_ffmpeg(url: str, destination: Path, headers: dict[str, str], duration_seconds: float | None = None, progress_callback = None, is_hls: bool = False) -> None:
        ua = headers.get("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
        
        if is_hls:
            cmd = [
                "yt-dlp",
                "--hls-prefer-native",
                "--concurrent-fragments", "4",
                "--retries", "10",
                "--fragment-retries", "10",
                "--retry-sleep", "fragment:exp=1:20",
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

            codec_args = ["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"]

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
                "-allowed_extensions", "ALL",
                "-allowed_segment_extensions", "ALL",
                "-protocol_whitelist", "file,http,https,tcp,tls,crypto,data",
                "-extension_picky", "0",
                "-seg_max_retry", "10",
                "-http_persistent", "0",
                "-timeout", "30000000",
                "-fflags", "+genpts+discardcorrupt",
                "-i", url
            ] + codec_args + [str(destination)]

        import asyncio
        from collections import deque
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        # Basic progress monitoring parsing ffmpeg/yt-dlp output
        error_log = deque(maxlen=20)
        try:
            while True:
                line = await process.stderr.readline()
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
                            await progress_callback(pct)
                    elif progress_callback and is_hls:
                        # yt-dlp progress: [download]  50.0% of ~2.50GiB
                        m = re.search(r"\[download\]\s+(\d+\.?\d*)%", line_str)
                        if not m:
                            m = re.search(r"\[download\]\s+(\d+\.?\d*)%", (await process.stdout.readline()).decode(errors='replace').strip())
                        if m:
                            pct = min(100, int(float(m.group(1))))
                            await progress_callback(pct)

            await asyncio.wait_for(process.wait(), timeout=settings.MAX_DURATION_SECONDS)
        except asyncio.TimeoutError:
            process.kill()
            destination.unlink(missing_ok=True)
            raise TimeoutError("FFmpeg/yt-dlp stream download timed out.")
            
        if process.returncode != 0:
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
                duration = float(stream_duration) if stream_duration else float(format_duration)
                return duration
            except (ValueError, TypeError):
                raise ValueError("Could not determine media duration")
        except json.JSONDecodeError:
            raise ValueError(f"Failed to parse ffprobe output. Output: {stdout}")
