from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI

from tests.helpers.runtime_service import ADMIN_KEY, READER_KEY


@pytest.fixture
async def running(runtime_app: FastAPI) -> AsyncGenerator[None]:
    async with runtime_app.router.lifespan_context(runtime_app):
        yield


@pytest.fixture
def actor() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def owner() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
async def admin(runtime_app: FastAPI, actor: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1/admin",
        headers={"Authorization": f"Bearer {ADMIN_KEY}", "X-End-User": str(actor)},
    ) as client:
        yield client


@pytest.fixture
async def app_client(runtime_app: FastAPI, owner: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1",
        headers={"Authorization": f"Bearer {READER_KEY}", "X-End-User": str(owner)},
    ) as client:
        yield client
