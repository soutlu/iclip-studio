"""iclip.brand_templates：资源类型与品牌，媒体参数独立可空。

Revision ID: 0f74c2a89d31
Revises: a7d8c31f42e9
Create Date: 2026-10-15 04:53:36.803236

将 position 改为 kind，保留已有 intro/outro 值；新增 brand，存量品牌未知，保持 NULL。
kind 是非空白的自由文本，不限定资源类型。宽高、时长与音轨各自可空，数值非空时必须为正。
降级前锁表核对：非旧版类型、任何品牌信息或缺失视频参数都拒绝，避免丢数据或猜测补值。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0f74c2a89d31"
down_revision: str | None = "a7d8c31f42e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "brand_templates"
_VIDEO_COLUMNS = ("width", "height", "duration_ms", "has_audio")


def upgrade() -> None:
    for constraint in ("position", "size", "duration"):
        op.drop_constraint(f"ck_brand_templates_{constraint}", TABLE, schema=SCHEMA, type_="check")
    op.alter_column(TABLE, "position", new_column_name="kind", schema=SCHEMA)
    op.add_column(TABLE, sa.Column("brand", sa.Text(), nullable=True), schema=SCHEMA)
    for column in _VIDEO_COLUMNS:
        op.alter_column(TABLE, column, nullable=True, schema=SCHEMA)
    op.create_check_constraint(
        "ck_brand_templates_kind", TABLE, "kind ~ '[^[:space:]]'", schema=SCHEMA
    )
    op.create_check_constraint(
        "ck_brand_templates_brand",
        TABLE,
        "brand IS NULL OR brand ~ '[^[:space:]]'",
        schema=SCHEMA,
    )
    op.create_check_constraint(
        "ck_brand_templates_size",
        TABLE,
        "(width IS NULL OR width > 0) AND (height IS NULL OR height > 0)",
        schema=SCHEMA,
    )
    op.create_check_constraint(
        "ck_brand_templates_duration",
        TABLE,
        "duration_ms IS NULL OR duration_ms > 0",
        schema=SCHEMA,
    )


def downgrade() -> None:
    connection = op.get_bind()
    # 预检与后续 DDL 共用锁，防止预检后并发写入的品牌信息被删列丢掉。
    connection.execute(sa.text("LOCK TABLE iclip.brand_templates IN ACCESS EXCLUSIVE MODE"))
    extended = connection.execute(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM iclip.brand_templates"
            " WHERE kind NOT IN ('intro', 'outro') OR brand IS NOT NULL"
            " OR width IS NULL OR height IS NULL OR duration_ms IS NULL OR has_audio IS NULL)"
        )
    ).scalar_one()
    if extended:
        raise RuntimeError("品牌资源含旧版不支持的类型、品牌或缺失视频参数，无法无损降级到 0029")
    for constraint in ("kind", "brand", "size", "duration"):
        op.drop_constraint(f"ck_brand_templates_{constraint}", TABLE, schema=SCHEMA, type_="check")
    for column in _VIDEO_COLUMNS:
        op.alter_column(TABLE, column, nullable=False, schema=SCHEMA)
    op.drop_column(TABLE, "brand", schema=SCHEMA)
    op.alter_column(TABLE, "kind", new_column_name="position", schema=SCHEMA)
    op.create_check_constraint(
        "ck_brand_templates_position", TABLE, "position IN ('intro', 'outro')", schema=SCHEMA
    )
    op.create_check_constraint(
        "ck_brand_templates_size", TABLE, "width > 0 AND height > 0", schema=SCHEMA
    )
    op.create_check_constraint(
        "ck_brand_templates_duration", TABLE, "duration_ms > 0", schema=SCHEMA
    )
