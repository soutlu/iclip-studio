"""iclip.whole_film_drafts 改存成片文件；成片记录的请求去掉草稿和字幕。

Revision ID: 9f3796a31ae4
Revises: aacc58dec9ab
Create Date: 2026-11-11 18:40:00.000000

成片草稿从 JSON 文档换成一份 HTML 成片文件（``html``）。旧草稿不做转换，直接清空。
已有成片记录的请求里去掉 ``document`` 和 ``subtitles``，只留版本号和用到的素材。

降级把列和约束换回来，成片记录的请求补上空的 ``document`` 和 ``subtitles``；清掉的草稿和
删掉的内容回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "9f3796a31ae4"
down_revision: str | None = "aacc58dec9ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
DRAFTS = "whole_film_drafts"

_DOCUMENT_CHECK = "ck_whole_film_drafts_document"


def upgrade() -> None:
    op.execute(f"DELETE FROM {SCHEMA}.{DRAFTS}")
    op.drop_constraint(_DOCUMENT_CHECK, DRAFTS, schema=SCHEMA, type_="check")
    op.drop_column(DRAFTS, "document", schema=SCHEMA)
    op.add_column(DRAFTS, sa.Column("html", sa.Text(), nullable=False), schema=SCHEMA)
    op.execute(
        f"UPDATE {SCHEMA}.generation_jobs SET request = request - 'document' - 'subtitles'"
        " WHERE kind = 'whole_film' AND operation = 'render'"
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM {SCHEMA}.{DRAFTS}")
    op.drop_column(DRAFTS, "html", schema=SCHEMA)
    op.add_column(DRAFTS, sa.Column("document", JSONB(), nullable=False), schema=SCHEMA)
    op.create_check_constraint(
        _DOCUMENT_CHECK, DRAFTS, "jsonb_typeof(document) = 'object'", schema=SCHEMA
    )
    op.execute(
        f"UPDATE {SCHEMA}.generation_jobs"
        """ SET request = request || '{"document": {}, "subtitles": []}'::jsonb"""
        " WHERE kind = 'whole_film' AND operation = 'render'"
    )
