from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import inspect, text
from app.config import settings

class Base(DeclarativeBase):
    pass

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if "sqlite" in settings.DATABASE_URL:
            columns = await conn.run_sync(
                lambda sync_conn: {column["name"] for column in inspect(sync_conn).get_columns("jobs")}
            )
            additions = {
                "source_headers": "JSON",
                "acquisition_mode": "VARCHAR(32) DEFAULT 'server' NOT NULL",
                "source_file_path": "TEXT",
                "failure_code": "VARCHAR(64)",
            }
            for name, sql_type in additions.items():
                if name not in columns:
                    await conn.execute(text(f"ALTER TABLE jobs ADD COLUMN {name} {sql_type}"))

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
