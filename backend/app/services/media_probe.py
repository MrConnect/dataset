"""FFprobe-based validation shared by downloads and browser uploads."""

import asyncio
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MediaInfo:
    duration: float
    width: int
    height: int
    start_time: float = 0.0


def run_subprocess_sync(cmd: list[str], timeout: float | None = None) -> tuple[int, str, str]:
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


def _to_float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # reject NaN


async def probe_video(file_path: Path) -> MediaInfo:
    """Validate that ``file_path`` is a playable video and describe it.

    Raises FileNotFoundError when the file is absent/empty and ValueError when
    FFprobe cannot find a usable video stream.
    """
    if not file_path.exists() or file_path.stat().st_size < 4096:
        raise FileNotFoundError(f"Media file '{file_path.name}' does not exist or is empty.")

    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "format=duration,size:stream=codec_type,duration,start_time,width,height",
        "-of", "json",
        str(file_path),
    ]

    try:
        returncode, stdout, stderr = await asyncio.to_thread(run_subprocess_sync, cmd, 60.0)
    except FileNotFoundError as exc:
        # The binary itself is missing; do not report that as a bad video.
        raise RuntimeError("ffprobe is not installed on the server") from exc
    if returncode != 0:
        raise ValueError(f"FFprobe media validation failed: {stderr.strip()[:500]}")

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Could not parse FFprobe output: {exc}") from exc

    streams = data.get("streams", [])
    if not streams:
        raise ValueError("File has no playable video stream")
    video_stream = streams[0]
    width, height = video_stream.get("width"), video_stream.get("height")
    if not width or not height:
        raise ValueError("Video stream has invalid dimensions")

    duration = _to_float(video_stream.get("duration"))
    if duration is None or duration <= 0:
        duration = _to_float(data.get("format", {}).get("duration"))
    if duration is None or duration <= 0:
        raise ValueError("File has no measurable video duration")

    return MediaInfo(
        duration=duration,
        width=int(width),
        height=int(height),
        start_time=_to_float(video_stream.get("start_time")) or 0.0,
    )
