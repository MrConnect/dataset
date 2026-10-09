from pydantic import BaseModel, Field


class VideoQualitySchema(BaseModel):
    height: int | None = None
    width: int | None = None
    bandwidth: int | None = None
    codecs: str | None = None
    label: str | None = None
    representation_id: str | None = None
    variant_url: str | None = None


class SourceResolveRequest(BaseModel):
    media_url: str = Field(..., description="Media URL to resolve and probe")
    type: str | None = Field(None, description="Optional hinted type: mp4, hls, dash")
    page_url: str | None = Field(None, description="Original page URL where media was detected")
    headers: dict[str, str] | None = Field(None, description="Optional HTTP headers such as Referer")


class SourceResolveResponse(BaseModel):
    media_url: str
    type: str
    duration_seconds: float | None = None
    qualities: list[VideoQualitySchema] = []
    status: str
    error: str | None = None
