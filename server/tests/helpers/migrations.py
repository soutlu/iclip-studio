from __future__ import annotations

from pathlib import Path

from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine

_SERVER_DIR = Path(__file__).resolve().parents[2]


def alembic_config(url: str) -> AlembicConfig:
    cfg = AlembicConfig(str(_SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(_SERVER_DIR / "migrations"))
    cfg.attributes["sqlalchemy_url"] = url
    return cfg


async def run_admin(url: str, statement: str) -> None:
    engine = build_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            await conn.execute(text(statement))
    finally:
        await engine.dispose()


__all__ = ["alembic_config", "run_admin"]
