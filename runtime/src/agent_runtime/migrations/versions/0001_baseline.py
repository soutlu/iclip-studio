"""基线：`agent_runtime` schema 的全部结构。

Revision ID: 8c41e7d2a9f3
Revises:
Create Date: 2026-11-07 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "8c41e7d2a9f3"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SCHEMA_SQL = Path(__file__).resolve().parent.parent / "data" / "baseline.sql"


def upgrade() -> None:
    bind = op.get_bind()
    for statement in _split_statements(_SCHEMA_SQL.read_text(encoding="utf-8")):
        # 原生执行：SQLAlchemy 的 text() 会把 PostgreSQL 的 :: 转换语法当成绑定参数。
        bind.exec_driver_sql(statement)


def downgrade() -> None:
    raise NotImplementedError("基线不能回退")


def _split_statements(sql: str) -> list[str]:
    """按分号切语句，$$ 包着的函数体整块保留；asyncpg 一次只吃一条语句。

    只适用于冻结的这份 SQL：美元引号只有 $$，字符串里没有分号；pg_dump 的整行注释带分号，先去掉。
    """

    statements: list[str] = []
    buffer: list[str] = []
    inside_body = False
    for chunk in sql.split("$$"):
        if inside_body:
            buffer.append(f"$${chunk}$$")
        else:
            code = "\n".join(line for line in chunk.split("\n") if not line.startswith("--"))
            *complete, remainder = code.split(";")
            for piece in complete:
                buffer.append(piece)
                statement = "".join(buffer).strip()
                if statement:
                    statements.append(statement)
                buffer = []
            buffer.append(remainder)
        inside_body = not inside_body
    tail = "".join(buffer).strip()
    if tail:
        statements.append(tail)
    return statements
