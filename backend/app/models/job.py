from datetime import datetime, timezone
from sqlalchemy import String, Integer, Float, DateTime, ForeignKey, JSON, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.session import Base


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    schema_version: Mapped[str] = mapped_column(String(16), default="1.0")
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    page_url: Mapped[str] = mapped_column(Text, nullable=False)
    media_url: Mapped[str] = mapped_column(Text, nullable=False)
    media_type: Mapped[str] = mapped_column(String(16), nullable=False)
    quality_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    representation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    variant_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_headers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    acquisition_mode: Mapped[str] = mapped_column(String(32), default="server")
    source_file_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    segments: Mapped[list["JobSegment"]] = relationship(
        "JobSegment", back_populates="job", cascade="all, delete-orphan", lazy="selectin"
    )


class JobSegment(Base):
    __tablename__ = "job_segments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String(64), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    segment_id: Mapped[str] = mapped_column(String(64), nullable=False)
    start_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    end_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    categories: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    output_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    job: Mapped["Job"] = relationship("Job", back_populates="segments")


class CategoryModel(Base):
    __tablename__ = "categories"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    color: Mapped[str] = mapped_column(String(32), nullable=False, default="#3b82f6")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    shortcut: Mapped[str | None] = mapped_column(String(8), nullable=True)
