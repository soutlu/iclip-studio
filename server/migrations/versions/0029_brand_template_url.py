"""iclip.brand_templates：将 ``video_url`` 列重命名为 ``url``。

Revision ID: a7d8c31f42e9
Revises: 476ee9b3b464
Create Date: 2026-10-15 04:35:39.999166

只统一字段名称，地址与其余模板数据原样保留；模板仍只用于视频片头、片尾。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "a7d8c31f42e9"
down_revision: str | None = "476ee9b3b464"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "brand_templates"


def upgrade() -> None:
    op.alter_column(TABLE, "video_url", new_column_name="url", schema=SCHEMA)


def downgrade() -> None:
    op.alter_column(TABLE, "url", new_column_name="video_url", schema=SCHEMA)
