from fastapi import Header, HTTPException, status
from app.config import settings


async def verify_api_key(x_api_key: str | None = Header(default=None)) -> str:
    """
    Verifies that the client provides a valid API key in X-API-Key header.
    """
    # If no API_KEY configured on server (or empty), bypass for development
    if not settings.API_KEY:
        return "anonymous"

    if not x_api_key or x_api_key != settings.API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API Key in X-API-Key header",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    return x_api_key
