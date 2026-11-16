from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Admin key. There is deliberately no default: when it is left empty the
    # server generates one on first start and stores it in
    # <BASE_STORAGE_DIR>/admin_key.txt (see app.core.security).
    API_KEY: str = ""
    DATABASE_URL: str = "sqlite+aiosqlite:///./tagger.db"
    REDIS_URL: str = "redis://localhost:6379/0"

    BASE_STORAGE_DIR: str = "./storage"
    DATASET_DIR: str = "./dataset"
    TEMP_DIR: str = "./storage/temp"

    MAX_DOWNLOAD_SIZE_BYTES: int = 5 * 1024 * 1024 * 1024  # 5 GB
    MAX_DURATION_SECONDS: int = 4 * 3600  # Hard ceiling for one source download
    MAX_SEGMENTS_PER_JOB: int = 500
    DOWNLOAD_TIMEOUT_SECONDS: int = 600
    # A download is considered hung when it produces neither output nor new
    # bytes on disk for this long.
    DOWNLOAD_STALL_TIMEOUT_SECONDS: int = 180
    KEEP_DOWNLOADED_SOURCES: bool = True

    # Chunked browser uploads
    UPLOAD_CHUNK_BYTES: int = 8 * 1024 * 1024
    UPLOAD_SESSION_TTL_SECONDS: int = 48 * 3600

    ALLOW_LOCAL_NETWORK: bool = False  # Anti-SSRF toggle (False by default for security)
    ACCURATE_CUTTING: bool = True  # Frame-accurate re-encoding
    CELERY_ENABLED: bool = False
    CONCURRENT_WORKERS: int = 2

    @property
    def dataset_path(self) -> Path:
        p = Path(self.DATASET_DIR)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def temp_path(self) -> Path:
        p = Path(self.TEMP_DIR)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def storage_path(self) -> Path:
        p = Path(self.BASE_STORAGE_DIR)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def downloads_path(self) -> Path:
        p = Path(self.BASE_STORAGE_DIR) / "downloads"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def uploads_path(self) -> Path:
        p = Path(self.TEMP_DIR) / "uploads"
        p.mkdir(parents=True, exist_ok=True)
        return p


settings = Settings()
