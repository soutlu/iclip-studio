"""用户加上所在配置组 ``model_group``。

Revision ID: 3f6b9d2a8c41
Revises: e3a95c1d7b42
Create Date: 2026-11-19 12:00:00.000000

可空，空即默认组；由 root 在网页上选，SSO 登录同步不碰。升级后所有人都在默认组，不回填。

降级删掉这一列，选过的组丢掉。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "3f6b9d2a8c41"
down_revision: str | None = "e3a95c1d7b42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.get_bind().exec_driver_sql("ALTER TABLE iclip.users ADD COLUMN model_group text")


def downgrade() -> None:
    op.get_bind().exec_driver_sql("ALTER TABLE iclip.users DROP COLUMN model_group")
