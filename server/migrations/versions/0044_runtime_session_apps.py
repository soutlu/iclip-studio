"""agent_runtime：会话归属应用。``sessions`` 加 ``app_id``，记开这个会话的接入应用。

Revision ID: fd5fe51c6ffc
Revises: 4d1a8c6e2b90
Create Date: 2026-10-30 23:30:00.000000

现有的行都是后端（应用 ``video``）开的，回填 ``video``；回填后去掉默认值，之后开会话必须写明是哪个应用。
按应用读的查询都带着会话 id 走主键，不另建索引。

降级删掉这一列。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fd5fe51c6ffc"
down_revision: str | None = "4d1a8c6e2b90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("app_id", sa.Text(), nullable=False, server_default="video"),
        schema=RUNTIME_SCHEMA,
    )
    op.alter_column("sessions", "app_id", server_default=None, schema=RUNTIME_SCHEMA)


def downgrade() -> None:
    op.drop_column("sessions", "app_id", schema=RUNTIME_SCHEMA)
