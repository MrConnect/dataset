import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from app.config import settings


class StorageManager:
    @staticmethod
    def sanitize_name(name: str) -> str:
        """
        Sanitizes names for safe filesystem path usage, preventing directory traversal.
        """
        clean = re.sub(r"[^a-zA-Z0-9_\-]", "_", name)
        return clean or "default"

    @staticmethod
    def calculate_sha256(file_path: Path) -> str:
        h = hashlib.sha256()
        with open(file_path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        return h.hexdigest()

    @staticmethod
    def store_segment_files(
        job_id: str,
        segment_id: str,
        temp_segment_path: Path,
        category_ids: list[str],
    ) -> list[str]:
        """
        Distributes extracted segment file to each category folder under dataset/.
        Uses hardlinks when supported, falling back to copy.
        Returns list of stored relative file paths.
        """
        dataset_dir = settings.dataset_path
        stored_paths: list[str] = []

        safe_job_id = StorageManager.sanitize_name(job_id)
        safe_seg_id = StorageManager.sanitize_name(segment_id)
        file_name = f"{safe_job_id}_{safe_seg_id}.mp4"

        categories = category_ids or ["uncategorized"]

        first_dest: Path | None = None

        for cat_id in categories:
            safe_cat_id = StorageManager.sanitize_name(cat_id)
            cat_dir = dataset_dir / safe_cat_id
            cat_dir.mkdir(parents=True, exist_ok=True)
            target_path = cat_dir / file_name

            target_path.unlink(missing_ok=True)

            if first_dest is None:
                # Copy or move from temp
                shutil.copy2(temp_segment_path, target_path)
                first_dest = target_path
            else:
                # Hardlink or copy if hardlink unsupported
                try:
                    os.link(first_dest, target_path)
                except (OSError, NotImplementedError):
                    shutil.copy2(first_dest, target_path)

            stored_paths.append(str(target_path.relative_to(dataset_dir.parent)))

        # Clean up temporary cut file
        temp_segment_path.unlink(missing_ok=True)
        return stored_paths

    @staticmethod
    def save_job_metadata(
        job_id: str,
        page_url: str,
        media_url: str,
        media_type: str,
        quality: dict,
        source_duration: float | None,
        segment_records: list[dict],
        categories_metadata: list[dict] | None = None,
        errors: list[str] | None = None,
    ) -> Path:
        """
        Writes complete traceable CVAT-ready metadata JSON to dataset/metadata/<job_id>.json
        """
        safe_job_id = StorageManager.sanitize_name(job_id)
        metadata_dir = settings.dataset_path / "metadata"
        metadata_dir.mkdir(parents=True, exist_ok=True)
        meta_file = metadata_dir / f"{safe_job_id}.json"

        data = {
            "schema_version": "1.0",
            "job_id": job_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": {
                "page_url": page_url,
                "media_url": media_url,
                "media_type": media_type,
                "duration_seconds": source_duration,
            },
            "selected_quality": quality,
            "categories_metadata": categories_metadata or [],
            "segments_count": len(segment_records),
            "segments": segment_records,
            "processing_errors": errors or [],
        }

        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        return meta_file
