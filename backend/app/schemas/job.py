import re
from datetime import datetime
from pydantic import BaseModel, Field, field_validator, model_validator
from app.schemas.category import CategorySchema


class SourceSchema(BaseModel):
    page_url: str = Field(..., description="Web page where media was located")
    media_url: str = Field(..., description="Direct media or manifest URL")
    type: str = Field(..., description="Type: mp4, hls, dash")
    duration_seconds: float | None = None
    headers: dict[str, str] | None = None


class QualitySelectionSchema(BaseModel):
    height: int | None = None
    representation_id: str | None = None
    variant_url: str | None = None


class SegmentItemSchema(BaseModel):
    id: str = Field(..., description="Unique segment ID")
    start_seconds: float = Field(..., ge=0, description="Start timestamp in seconds")
    end_seconds: float = Field(..., gt=0, description="End timestamp in seconds")
    categories: list[str] = Field(..., min_length=1, description="List of category IDs")

    @field_validator("id")
    @classmethod
    def validate_segment_id(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_\-\.]+$", v):
            raise ValueError("Segment ID must contain only alphanumeric characters, dashes, and underscores.")
        return v

    @model_validator(mode="after")
    def validate_interval(self):
        if self.end_seconds <= self.start_seconds:
            raise ValueError(
                f"end_seconds ({self.end_seconds}) must be greater than start_seconds ({self.start_seconds})"
            )
        return self


class JobPayload(BaseModel):
    schema_version: str = Field("1.0", description="Schema version identifier")
    source: SourceSchema
    quality: QualitySelectionSchema = Field(default_factory=QualitySelectionSchema)
    segments: list[SegmentItemSchema] = Field(..., min_length=1, description="List of segments to extract")
    categories_metadata: list[CategorySchema] | None = None


class JobSubmitResponse(BaseModel):
    job_id: str
    status: str
    segments_count: int
    message: str | None = None


class SegmentResult(BaseModel):
    id: str
    start_seconds: float
    end_seconds: float
    categories: list[str]
    status: str
    output_path: str | None = None
    duration: float | None = None
    error: str | None = None


class JobDetailResponse(BaseModel):
    job_id: str
    schema_version: str
    status: str
    page_url: str
    media_url: str
    media_type: str
    quality_height: int | None = None
    duration_seconds: float | None = None
    progress: int = 0
    error: str | None = None
    segments_count: int
    created_at: datetime
    updated_at: datetime
    segments: list[SegmentResult] = []
