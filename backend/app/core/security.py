"""Authentication.

Two kinds of credentials are accepted in the ``X-API-Key`` header:

* the **admin key** (``API_KEY`` env, or auto-generated on first start), which
  can do everything including managing client keys and the database;
* **client keys** created from the dashboard, one per extension/browser, which
  can use the pipeline but cannot manage keys or the database.

Browsers cannot attach headers to ``<video src>`` or download links, so file
GET routes additionally accept a short-lived, HttpOnly, SameSite=Strict
session cookie that is issued only in exchange for a valid key. The cookie is
never accepted on state-changing routes.
"""

import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.session import get_db
from app.models.job import ApiKey

logger = logging.getLogger("security")

MEDIA_COOKIE_NAME = "vdt_media"
MEDIA_COOKIE_TTL_SECONDS = 12 * 3600
CLIENT_KEY_PREFIX = "vdt_"

_generated_admin_key: str | None = None


@dataclass(frozen=True)
class Principal:
    role: str  # "admin" | "client" | "session"
    key_id: str | None = None
    name: str | None = None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def get_admin_key() -> str:
    """Return the admin key, generating and persisting one if none is configured."""
    global _generated_admin_key
    if settings.API_KEY:
        return settings.API_KEY
    if _generated_admin_key:
        return _generated_admin_key

    key_file = settings.storage_path / "admin_key.txt"
    if key_file.exists():
        stored = key_file.read_text(encoding="utf-8").strip()
        if stored:
            _generated_admin_key = stored
            return stored

    generated = secrets.token_urlsafe(32)
    key_file.write_text(generated, encoding="utf-8")
    try:
        key_file.chmod(0o600)
    except OSError:
        pass
    _generated_admin_key = generated
    logger.warning(
        "No API_KEY configured. Generated an admin key and saved it to %s — "
        "use it to sign in to the dashboard: %s",
        key_file,
        generated,
    )
    return generated


def hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def generate_client_key() -> str:
    return f"{CLIENT_KEY_PREFIX}{secrets.token_urlsafe(32)}"


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing API Key in X-API-Key header",
        headers={"WWW-Authenticate": "ApiKey"},
    )


async def _principal_for_key(value: str | None, db: AsyncSession) -> Principal | None:
    if not value:
        return None
    if hmac.compare_digest(value.encode("utf-8"), get_admin_key().encode("utf-8")):
        return Principal(role="admin", name="admin")

    record = (
        await db.execute(select(ApiKey).where(ApiKey.key_hash == hash_key(value)))
    ).scalar_one_or_none()
    if record is None:
        return None

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # Avoid a write on every request; minute resolution is plenty for "last used".
    if record.last_used_at is None or now - record.last_used_at > timedelta(minutes=1):
        record.last_used_at = now
        await db.commit()
    return Principal(role="client", key_id=record.id, name=record.name)


async def verify_api_key(
    x_api_key: Annotated[str | None, Header()] = None,
    db: AsyncSession = Depends(get_db),
) -> Principal:
    principal = await _principal_for_key(x_api_key, db)
    if principal is None:
        raise _unauthorized()
    return principal


async def require_admin(principal: Annotated[Principal, Depends(verify_api_key)]) -> Principal:
    if not principal.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires the admin key",
        )
    return principal


# --- Media session cookie -------------------------------------------------

def _session_secret() -> bytes:
    return hmac.new(get_admin_key().encode("utf-8"), b"vdt-media-session", hashlib.sha256).digest()


def create_media_session_token(ttl_seconds: int = MEDIA_COOKIE_TTL_SECONDS) -> str:
    expires = str(int(time.time()) + ttl_seconds)
    signature = hmac.new(_session_secret(), expires.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{expires}.{signature}"


def is_valid_media_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expires, _, signature = token.partition(".")
    if not expires.isdigit():
        return False
    expected = hmac.new(_session_secret(), expires.encode("ascii"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected) and int(expires) > time.time()


async def verify_media_access(
    x_api_key: Annotated[str | None, Header()] = None,
    vdt_media: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> Principal:
    """Read-only file access: API key header or the media session cookie."""
    principal = await _principal_for_key(x_api_key, db)
    if principal is not None:
        return principal
    if is_valid_media_session(vdt_media):
        return Principal(role="session")
    raise _unauthorized()
