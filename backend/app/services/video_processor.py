import asyncio
import json
import math
from pathlib import Path

from app.services.downloader import _run_subprocess_sync

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
        if not math.isfinite(start_seconds) or not math.isfinite(end_seconds):
            raise ValueError("Segment timestamps must be finite numbers")
        if start_seconds < 0 or end_seconds <= start_seconds:
            raise ValueError("Segment end time must be greater than its non-negative start time")

        if total_duration is not None and math.isfinite(total_duration) and total_duration > 0:
            if start_seconds >= total_duration:
                raise ValueError(
                    f"Segment start {start_seconds:.3f}s is beyond downloaded video duration {total_duration:.3f}s"
                )
            if end_seconds > total_duration:
                overrun = end_seconds - total_duration
                if overrun > 0.05:
                    raise ValueError(
                        f"Segment end {end_seconds:.3f}s is beyond downloaded video duration {total_duration:.3f}s"
                    )
                end_seconds = total_duration

        duration = end_seconds - start_seconds

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
        # --- FRAME-ACCURATE CUTTING FROM LOCAL FILE ---
        # Input seeking remains fast while accurate_seek (FFmpeg default while
        # transcoding) decodes/discards frames up to the requested timestamp.
        # Explicit trims reset timestamps and prevent CFR from manufacturing
        # extra frames around the requested end boundary.
        duration_text = f"{duration:.6f}"
        cmd_cut = [
            "ffmpeg", "-y", "-nostdin", "-v", "warning",
            "-ss", f"{start_seconds:.6f}",
            "-i", source_str,
            "-t", duration_text,
            "-map", "0:v:0?", "-map", "0:a:0?",
            "-vf", f"trim=duration={duration_text},setpts=PTS-STARTPTS",
            "-af", f"atrim=duration={duration_text},asetpts=PTS-STARTPTS",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k",
            "-map_metadata", "-1", "-map_chapters", "-1",
            "-movflags", "+faststart",
            str(output_path)
        ]

        returncode, _stdout, stderr = await asyncio.to_thread(_run_subprocess_sync, cmd_cut, 600.0)
        if returncode != 0:
            raise RuntimeError(f"Segment Cut failed: {stderr}")

        # Validate extracted segment with FFprobe
        actual_duration = await VideoProcessor._verify_segment_file(output_path, duration)
        return actual_duration

    @staticmethod
    async def _verify_segment_file(file_path: Path, expected_duration: float | None = None) -> float:
        if not file_path.exists() or file_path.stat().st_size < 4096:
            raise FileNotFoundError(f"Generated segment file {file_path} is missing or too small to contain video.")

        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "format=duration:stream=codec_type,width,height",
            "-of", "json",
            str(file_path),
        ]

        returncode, stdout, stderr = await asyncio.to_thread(_run_subprocess_sync, cmd, 30.0)
        if returncode != 0:
            raise ValueError(f"FFprobe failed to verify extracted segment: {stderr}")

        data = json.loads(stdout)
        streams = data.get("streams", [])
        if not streams or not streams[0].get("width") or not streams[0].get("height"):
            file_path.unlink(missing_ok=True)
            raise ValueError("Generated segment contains no playable video stream")
        dur_str = data.get("format", {}).get("duration")
        duration = float(dur_str) if dur_str else 0.0
        minimum = 0.1
        if duration < minimum:
            file_path.unlink(missing_ok=True)
            raise ValueError(
                f"Generated segment duration {duration:.3f}s is too short (empty file)"
            )
        if expected_duration is not None:
            # MP4/AAC timestamps and the source frame grid can differ by a few
            # milliseconds. Anything beyond 120 ms is a real range transfer
            # error rather than normal frame/audio rounding.
            drift = abs(duration - expected_duration)
            if drift > 0.12:
                file_path.unlink(missing_ok=True)
                raise ValueError(
                    f"Generated segment duration drifted by {drift:.3f}s "
                    f"(expected {expected_duration:.3f}s, got {duration:.3f}s)"
                )
        return duration
