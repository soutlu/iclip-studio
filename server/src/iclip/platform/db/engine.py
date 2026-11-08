from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def build_engine(database_url: str, **options: Any) -> AsyncEngine:
    return create_async_engine(database_url, pool_pre_ping=True, **options)


__all__ = ["build_engine"]
