from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    API_KEY: str = "test_dev_key"
    DATABASE_URL: str = "sqlite+aiosqlite:///./tagger.db"
    REDIS_URL: str = "redis://localhost:6379/0"
    
    BASE_STORAGE_DIR: str = "./storage"
    DATASET_DIR: str = "./dataset"
    TEMP_DIR: str = "./storage/temp"

    MAX_DOWNLOAD_SIZE_BYTES: int = 5 * 1024 * 1024 * 1024  # 5 GB
    MAX_DURATION_SECONDS: int = 4 * 3600  # 4 Hours
    MAX_SEGMENTS_PER_JOB: int = 500
    DOWNLOAD_TIMEOUT_SECONDS: int = 600

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


settings = Settings()
