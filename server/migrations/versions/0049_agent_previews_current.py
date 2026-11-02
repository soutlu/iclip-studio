"""agent 测试预览：每人每个 agent 只有一段当前预览。

Revision ID: 4f2a9c7e1b30
Revises: 9cde6b3a5040
Create Date: 2026-11-01 14:00:00.000000

``iclip.agent_previews`` 加唯一约束 ``(owner_user_id, agent_id)``：一行就是这个人在这个 agent 上的当前预览，
开新的就把这一行换成新的 id；``version_id`` 只是当前这段试的目标，不进约束。表里还没有正式数据，不做去重：
已有重复时升级直接失败。

降级删掉这个约束。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "4f2a9c7e1b30"
down_revision: str | None = "9cde6b3a5040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

APP_SCHEMA = "iclip"


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_agent_previews_owner_agent",
        "agent_previews",
        ["owner_user_id", "agent_id"],
        schema=APP_SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_agent_previews_owner_agent", "agent_previews", schema=APP_SCHEMA, type_="unique"
    )
