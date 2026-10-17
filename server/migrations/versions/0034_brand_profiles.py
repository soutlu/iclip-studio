"""iclip：品牌资源只剩字体，另起 ``brand_profiles`` 记每个品牌的标语与强调色。

Revision ID: 44c6505380a0
Revises: e82dd7339835
Create Date: 2026-10-17 21:00:00.000000

片头片尾改成整片里的组件（ADR-0003），品牌模板里的片头片尾视频不再使用：删掉 ``kind`` 为
``intro`` / ``outro`` 的行，再删掉只有它们用过的宽高、时长与音轨四列和两条约束；字体从来不写这四列。
新表一个品牌一行，品牌名与资源上的 ``brand`` 同一套规则、按字面对上。

降级删新表，四列与约束按迁移 0030 的形状加回（都可空）；删掉的片头片尾、四列里的值与标语、强调色
都回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "44c6505380a0"
down_revision: str | None = "e82dd7339835"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TEMPLATES = "brand_templates"
PROFILES = "brand_profiles"


def upgrade() -> None:
    """删片头片尾与视频四列，建品牌表；约束与 ``brand_templates.infra_sql`` 同名同式。"""

    op.execute(f"DELETE FROM {SCHEMA}.{TEMPLATES} WHERE kind IN ('intro', 'outro')")
    for constraint in ("size", "duration"):
        op.drop_constraint(
            f"ck_brand_templates_{constraint}", TEMPLATES, schema=SCHEMA, type_="check"
        )
    for column in ("width", "height", "duration_ms", "has_audio"):
        op.drop_column(TEMPLATES, column, schema=SCHEMA)
    op.create_table(
        PROFILES,
        sa.Column("brand", sa.Text(), nullable=False),
        sa.Column("slogan", sa.Text(), nullable=True),
        sa.Column("accent_color", sa.Text(), nullable=True),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("brand ~ '[^[:space:]]'", name="ck_brand_profiles_brand"),
        sa.CheckConstraint(
            "slogan IS NULL OR (btrim(slogan) <> '' AND char_length(slogan) <= 100)",
            name="ck_brand_profiles_slogan",
        ),
        sa.CheckConstraint(
            "accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'",
            name="ck_brand_profiles_accent_color",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"], [f"{SCHEMA}.users.id"], name="fk_brand_profiles_updated_by"
        ),
        sa.PrimaryKeyConstraint("brand"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    """删品牌表，四列与约束按 0030 的形状加回；数据不恢复。"""

    op.drop_table(PROFILES, schema=SCHEMA)
    op.add_column(TEMPLATES, sa.Column("width", sa.Integer(), nullable=True), schema=SCHEMA)
    op.add_column(TEMPLATES, sa.Column("height", sa.Integer(), nullable=True), schema=SCHEMA)
    op.add_column(TEMPLATES, sa.Column("duration_ms", sa.Integer(), nullable=True), schema=SCHEMA)
    op.add_column(TEMPLATES, sa.Column("has_audio", sa.Boolean(), nullable=True), schema=SCHEMA)
    op.create_check_constraint(
        "ck_brand_templates_size",
        TEMPLATES,
        "(width IS NULL OR width > 0) AND (height IS NULL OR height > 0)",
        schema=SCHEMA,
    )
    op.create_check_constraint(
        "ck_brand_templates_duration",
        TEMPLATES,
        "duration_ms IS NULL OR duration_ms > 0",
        schema=SCHEMA,
    )
