"""agent_runtime：MCP 服务的地址加密存、不能重复，名称不能重复。``mcp_servers`` 加列 ``url_hash``。

Revision ID: 8d1e6b3f5a92
Revises: 9cde6b3a5040
Create Date: 2026-11-01 18:00:00.000000

``url`` 列名不变，改存用 ``CREDENTIAL_ENCRYPTION_KEYS`` 加密的密文；新列 ``url_hash`` 是明文地址的 sha256
（十六进制），表上按它判地址不重复（唯一约束 ``uq_mcp_servers_url_hash``），``name`` 另有唯一约束
``uq_mcp_servers_name``。不迁数据：表里已有行时加非空列直接失败。

降级去掉两条唯一约束与 ``url_hash``，``url`` 里留下的仍是密文。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8d1e6b3f5a92"
down_revision: str | None = "9cde6b3a5040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.add_column(
        "mcp_servers",
        sa.Column("url_hash", sa.Text(), nullable=False),
        schema=RUNTIME_SCHEMA,
    )
    op.create_unique_constraint(
        "uq_mcp_servers_url_hash", "mcp_servers", ["url_hash"], schema=RUNTIME_SCHEMA
    )
    op.create_unique_constraint(
        "uq_mcp_servers_name", "mcp_servers", ["name"], schema=RUNTIME_SCHEMA
    )


def downgrade() -> None:
    op.drop_constraint("uq_mcp_servers_name", "mcp_servers", schema=RUNTIME_SCHEMA)
    op.drop_constraint("uq_mcp_servers_url_hash", "mcp_servers", schema=RUNTIME_SCHEMA)
    op.drop_column("mcp_servers", "url_hash", schema=RUNTIME_SCHEMA)
