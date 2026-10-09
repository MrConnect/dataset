import re
from pydantic import BaseModel, Field, field_validator


class CategorySchema(BaseModel):
    id: str = Field(..., description="Permanent unique category ID")
    name: str = Field(..., min_length=1, max_length=128)
    color: str = Field("#3b82f6", max_length=32)
    description: str | None = None
    shortcut: str | None = Field(None, max_length=8)

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_\-\.]+$", v):
            raise ValueError("Category ID must contain only alphanumeric characters, dashes, underscores, and dots.")
        return v
