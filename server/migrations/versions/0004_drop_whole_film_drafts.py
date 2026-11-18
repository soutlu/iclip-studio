"""删掉成片草稿表 ``iclip.whole_film_drafts``。

Revision ID: 3c1f7a9d2b64
Revises: e257badecd70
Create Date: 2026-11-15 12:00:00.000000

剪辑编辑器改成读写对话工作区里的剪辑工程，草稿不再存在后端。表里的草稿不做转换，随表删掉。

降级按删之前的样子建回一张空表；删掉的草稿回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3c1f7a9d2b64"
down_revision: str | None = "e257badecd70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
DRAFTS = "whole_film_drafts"


def upgrade() -> None:
    op.drop_table(DRAFTS, schema=SCHEMA)


def downgrade() -> None:
    op.create_table(
        DRAFTS,
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("html", sa.Text(), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_whole_film_drafts_revision"),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            [f"{SCHEMA}.conversations.id"],
            name="fk_whole_film_drafts_conversation",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"], [f"{SCHEMA}.users.id"], name="fk_whole_film_drafts_updated_by"
        ),
        sa.PrimaryKeyConstraint("conversation_id", name="whole_film_drafts_pkey"),
        schema=SCHEMA,
    )
