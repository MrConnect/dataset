import os
from pathlib import Path
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from app.config import settings
from app.db.session import Base, engine, get_db, AsyncSessionLocal
from app.main import app


@pytest_asyncio.fixture(autouse=True)
async def setup_test_db():
    # Setup test tables on the shared application engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def auth_headers():
    return {"X-API-Key": settings.API_KEY}
