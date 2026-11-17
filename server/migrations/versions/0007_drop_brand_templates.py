"""删掉废弃的品牌模板表 ``iclip.brand_templates`` 与 ``iclip.brand_profiles``。

Revision ID: c84e19a3b502
Revises: 7d2a4c9e1f38
Create Date: 2026-11-17 01:32:00.000000

成片字体已随 HyperFrames 切换为从只读挂载的组件库目录读取，品牌模板接口与两张表均无调用方，
连同表内历史数据一并移除。

降级按原定义建回两张空表；删掉的数据回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c84e19a3b502"
down_revision: str | None = "7d2a4c9e1f38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TEMPLATES = "brand_templates"
PROFILES = "brand_profiles"


def upgrade() -> None:
    op.drop_table(TEMPLATES, schema=SCHEMA)
    op.drop_table(PROFILES, schema=SCHEMA)


def downgrade() -> None:
    op.create_table(
        PROFILES,
        sa.Column("brand", sa.Text(), nullable=False),
        sa.Column("slogan", sa.Text(), nullable=True),
        sa.Column("accent_color", sa.Text(), nullable=True),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'",
            name="ck_brand_profiles_accent_color",
        ),
        sa.CheckConstraint("brand ~ '[^[:space:]]'", name="ck_brand_profiles_brand"),
        sa.CheckConstraint(
            "slogan IS NULL OR (btrim(slogan) <> '' AND char_length(slogan) <= 100)",
            name="ck_brand_profiles_slogan",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"], [f"{SCHEMA}.users.id"], name="fk_brand_profiles_updated_by"
        ),
        sa.PrimaryKeyConstraint("brand", name="brand_profiles_pkey"),
        schema=SCHEMA,
    )
    op.create_table(
        TEMPLATES,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("brand", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "brand IS NULL OR brand ~ '[^[:space:]]'", name="ck_brand_templates_brand"
        ),
        sa.CheckConstraint("kind ~ '[^[:space:]]'", name="ck_brand_templates_kind"),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_brand_templates_name"),
        sa.ForeignKeyConstraint(
            ["created_by"], [f"{SCHEMA}.users.id"], name="fk_brand_templates_created_by"
        ),
        sa.PrimaryKeyConstraint("id", name="brand_templates_pkey"),
        schema=SCHEMA,
    )
