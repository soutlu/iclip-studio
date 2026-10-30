"""iclip：模型供应商。新表 ``model_providers``、``provider_credentials``、``provider_models``、
``default_models``。

Revision ID: 3c8e5f1a9b27
Revises: 3d9f6b2a8c51
Create Date: 2026-10-30 12:00:00.000000

``model_providers`` 是接入的供应商，``provider`` 是它用的声明名（声明随代码发布，不进库）；
``default_credential_id`` 不加外键，由服务在改它的事务里核对它属于本供应商。``provider_credentials``
是供应商的密钥，``fields`` 里声明为机密的字段存 MultiFernet 密文。``provider_models`` 只记声明里模型的
停用（``source = declared``）与自己加的模型（``source = custom``，``properties`` 带完整属性）。
``default_models`` 每个模型类型一行，按「供应商 + 模型名」引用。类型与来源的取值只在 Python 里检查，
不加 CHECK。

降级删掉四张表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "3c8e5f1a9b27"
down_revision: str | None = "3d9f6b2a8c51"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def _timestamp(name: str) -> sa.Column[object]:
    return sa.Column(
        name, sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
    )


def upgrade() -> None:
    op.create_table(
        "model_providers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("default_credential_id", sa.Uuid(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_model_providers_name"),
        schema=SCHEMA,
    )
    op.create_table(
        "provider_credentials",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("fields", JSONB(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.ForeignKeyConstraint(
            ["provider_id"], [f"{SCHEMA}.model_providers.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["created_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_id", "name", name="uq_provider_credentials_provider_name"),
        schema=SCHEMA,
    )
    op.create_table(
        "provider_models",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("properties", JSONB(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["provider_id"], [f"{SCHEMA}.model_providers.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider_id", "name", "type", name="uq_provider_models_provider_name_type"
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "default_models",
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        _timestamp("updated_at"),
        sa.ForeignKeyConstraint(["provider_id"], [f"{SCHEMA}.model_providers.id"]),
        sa.PrimaryKeyConstraint("type"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("default_models", schema=SCHEMA)
    op.drop_table("provider_models", schema=SCHEMA)
    op.drop_table("provider_credentials", schema=SCHEMA)
    op.drop_table("model_providers", schema=SCHEMA)
