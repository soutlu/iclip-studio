"""agent_runtime：快照消息按 sha256 只存一份，新表 ``snapshot_messages``；``snapshots`` 补会话索引。

Revision ID: ad8ae2f51ce1
Revises: a6e8d20c4f91
Create Date: 2026-10-27 12:00:00.000000

``snapshot_messages`` 的列对齐官方 PostgresStepStore 的 ``{table}_messages``。新写的快照行在
``messages`` 里只存 ``{"message_refs": [...]}``；已有行不在这里改写，仍按内联历史读。
``idx_snapshots_conv`` 服务于按会话取最新快照。

降级删掉索引与 ``snapshot_messages``：已按引用存的快照随之丢失历史。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ad8ae2f51ce1"
down_revision: str | None = "a6e8d20c4f91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.create_table(
        "snapshot_messages",
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("sha256"),
        schema=SCHEMA,
    )
    op.create_index("idx_snapshots_conv", "snapshots", ["conversation_id", "seq"], schema=SCHEMA)


def downgrade() -> None:
    op.drop_index("idx_snapshots_conv", table_name="snapshots", schema=SCHEMA)
    op.drop_table("snapshot_messages", schema=SCHEMA)
