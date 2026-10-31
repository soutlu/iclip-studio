"""迁移测试的共用件：指向某个库的 Alembic 配置，以及只能在事务外跑的管理语句。"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine

_SERVER_DIR = Path(__file__).resolve().parents[2]


def alembic_config(url: str) -> AlembicConfig:
    """按仓库里的 ``alembic.ini`` 与迁移目录，为 ``url`` 那个库配置迁移。"""

    cfg = AlembicConfig(str(_SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(_SERVER_DIR / "migrations"))
    cfg.attributes["sqlalchemy_url"] = url
    return cfg


async def run_admin(url: str, statement: str) -> None:
    """CREATE / DROP DATABASE 不能在事务里跑，走自动提交。"""

    engine = build_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            await conn.execute(text(statement))
    finally:
        await engine.dispose()


__all__ = ["alembic_config", "run_admin"]
