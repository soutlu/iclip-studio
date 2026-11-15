"""成片记录的请求里去掉 ``revision``。

Revision ID: 5b8e2d4f7a10
Revises: 3c1f7a9d2b64
Create Date: 2026-11-15 18:00:00.000000

导出不再按草稿的版本号取文件，交给渲染服务时直接读对话工作区里的 final-cut 工程；``videos``、
``audios`` 原样留着。

降级给每条成片记录补回 ``revision: 0``；原来的版本号回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "5b8e2d4f7a10"
down_revision: str | None = "3c1f7a9d2b64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WHOLE_FILM = "kind = 'whole_film' AND operation = 'render'"


def upgrade() -> None:
    op.execute(
        "UPDATE iclip.generation_jobs SET request = request - 'revision'"
        f" WHERE {_WHOLE_FILM} AND request ? 'revision'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE iclip.generation_jobs SET request = request || jsonb_build_object('revision', 0)"
        f" WHERE {_WHOLE_FILM} AND NOT request ? 'revision'"
    )
