"""iclip：``conversations`` 加列 ``same_as``，记下做同款新对话的源对话。

Revision ID: a4dfc0e6ca1c
Revises: 0d745e5b43c5
Create Date: 2026-11-06 18:00:00.000000

分析要数资料库带出了多少段对话，而 ``POST /conversations`` 的 ``sameAs`` 用完就丢了。不回填：
更早的对话已经查不出来源，留 ``NULL``。源对话的行被删时置空（``fk_conversations_same_as``）。

降级去掉外键与 ``same_as``，已记下的来源不保留。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4dfc0e6ca1c"
down_revision: str | None = "0d745e5b43c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "conversations"
SAME_AS_FK = "fk_conversations_same_as"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("same_as", sa.Uuid(), nullable=True), schema=SCHEMA)
    op.create_foreign_key(
        SAME_AS_FK,
        TABLE,
        TABLE,
        ["same_as"],
        ["id"],
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
        ondelete="set null",
    )


def downgrade() -> None:
    op.drop_constraint(SAME_AS_FK, TABLE, type_="foreignkey", schema=SCHEMA)
    op.drop_column(TABLE, "same_as", schema=SCHEMA)
