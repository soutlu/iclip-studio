"""数据库 engine 的构造：应用、测试、迁移与管理脚本共用，连接池行为一致。"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def build_engine(database_url: str, **options: Any) -> AsyncEngine:
    """建数据库 engine 的唯一入口。

    取连接前先 ping：查询被取消打断时，SQLAlchemy 作废连接的清理可能被再次取消，已关闭的
    asyncpg 连接会留在池里，ping 在下次取出时把它换掉。``options`` 原样传给
    ``create_async_engine``，如 ``connect_args``、``poolclass``。
    """

    return create_async_engine(database_url, pool_pre_ping=True, **options)


__all__ = ["build_engine"]
