"""为用户表新增 ``model_group`` 列以记录所属配置组。

Revision ID: 3f6b9d2a8c41
Revises: e3a95c1d7b42
Create Date: 2026-11-19 12:00:00.000000

字段可为空（为空表示默认组），由 root 在管理后台分配，SSO 登录同步不会覆盖该字段。
升级后现有用户默认归属默认组，不做数据回填；降级将删除该列并清除已分配的组信息。
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
