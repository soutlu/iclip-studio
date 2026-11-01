"""agent_runtime：MCP 服务。新表 ``mcp_servers``。

Revision ID: 9cde6b3a5040
Revises: b3841ad11a3d
Create Date: 2026-11-01 12:00:00.000000

一个服务一行，``id`` 是标识（文本，创建后不能改）。``headers`` 是 jsonb ``[{name, value}]``，值用
``CREDENTIAL_ENCRYPTION_KEYS`` 加密；``check_*`` 与 ``checked_at`` 是上一次试连，``tools`` 是最后一次试连
成功时发现的工具 ``[{name, description}]``，都可以为空。操作人列记应用给的用户 id，不加外键；连接方式与
jsonb 的形状只在 Python 里检查，不加 CHECK。

降级删掉这张表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "9cde6b3a5040"
down_revision: str | None = "b3841ad11a3d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_SCHEMA = "agent_runtime"


def _timestamp(name: str) -> sa.Column[object]:
    return sa.Column(
        name, sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
    )


def upgrade() -> None:
    op.create_table(
        "mcp_servers",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("transport", sa.Text(), nullable=False),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False),
        sa.Column("headers", JSONB(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("check_ok", sa.Boolean(), nullable=True),
        sa.Column("check_elapsed_ms", sa.Integer(), nullable=True),
        sa.Column("check_reason", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tools", JSONB(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id"),
        schema=RUNTIME_SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("mcp_servers", schema=RUNTIME_SCHEMA)
