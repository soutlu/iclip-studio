"""agent_runtime.materials：删掉对话素材台账。

Revision ID: 5c2a8e1f7d04
Revises: 3b7e2d9f4c61
Create Date: 2026-11-03 12:00:00.000000

工具收的媒体地址不再按对话登记过没有来认，改在提交时查能不能取到、类型对不对，这张表没有读者了。

降级只建回空表（同 0001_baseline 的定义），删掉时的数据不恢复。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5c2a8e1f7d04"
down_revision: str | None = "3b7e2d9f4c61"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "agent_runtime"
TABLE = "materials"


def upgrade() -> None:
    op.drop_table(TABLE, schema=SCHEMA)


def downgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("namespace", "url"),
        schema=SCHEMA,
    )
