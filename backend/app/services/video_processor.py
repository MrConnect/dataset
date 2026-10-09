import asyncio
import json
from pathlib import Path
import subprocess

from app.services.downloader import _run_subprocess_sync


import hashlib

_DOWNLOAD_LOCKS = {}

class VideoProcessor:
    @staticmethod
    async def extract_segment(
        source_path: Path | str,
        start_seconds: float,
        end_seconds: float,
        output_path: Path,
        total_duration: float | None = None,
        headers: dict[str, str] | None = None,
        **kwargs,
    ) -> float:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        duration = max(0.01, end_seconds - start_seconds)

        actual_duration = await VideoProcessor._extract_segment_ffmpeg(
            source_path=source_path,
            start_seconds=start_seconds,
            duration=duration,
            output_path=output_path,
            headers=headers,
        )
        return actual_duration

    @staticmethod
    async def _extract_segment_ffmpeg(
        source_path: Path | str,
        start_seconds: float,
        duration: float,
        output_path: Path,
        headers: dict[str, str] | None = None,
    ) -> float:
        source_str = str(source_path)
        is_remote = source_str.startswith("http://") or source_str.startswith("https://")

        remote_args = []
        if is_remote and headers:
            ua = headers.get("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
            headers_list = [f"{k}: {v}" for k, v in headers.items() if k.lower() != "user-agent"]
            if "Origin" not in headers and "Referer" in headers:
                ref = headers["Referer"]
                origin = "/".join(ref.split("/")[:3])
                headers_list.append(f"Origin: {origin}")
            headers_str = "".join(f"{h}\r\n" for h in headers_list)
            remote_args = ["-user_agent", ua, "-headers", headers_str]

        from app.config import settings
        
        # --- FRAME-ACCURATE CUTTING FROM LOCAL FILE ---
        # The source_str is already guaranteed to be a downloaded local file in temp path.
        cmd_cut = [
            "ffmpeg", "-y", "-nostdin", "-v", "warning",
            "-ss", f"{start_seconds:.3f}",
            "-i", source_str,
            "-t", f"{duration:.3f}",
            "-map", "0:v:0?", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k",
            "-avoid_negative_ts", "make_zero", "-fps_mode", "cfr",
            "-movflags", "+faststart",
            str(output_path)
        ]

        returncode, _stdout, stderr = await asyncio.to_thread(_run_subprocess_sync, cmd_cut, 600.0)
        if returncode != 0:
            raise RuntimeError(f"Segment Cut failed: {stderr}")

        # Validate extracted segment with FFprobe
        actual_duration = await VideoProcessor._verify_segment_file(output_path)
        return actual_duration

    @staticmethod
    async def _verify_segment_file(file_path: Path) -> float:
        if not file_path.exists() or file_path.stat().st_size == 0:
            raise FileNotFoundError(f"Generated segment file {file_path} is missing or empty.")

        cmd = [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json",
            str(file_path),
        ]

        returncode, stdout, stderr = await asyncio.to_thread(_run_subprocess_sync, cmd, 30.0)
        if returncode != 0:
            raise ValueError(f"FFprobe failed to verify extracted segment: {stderr}")

        data = json.loads(stdout)
        dur_str = data.get("format", {}).get("duration")
        return float(dur_str) if dur_str else 0.0
