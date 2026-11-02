"""iclip.reference_videos：去掉失败原因的 CHECK，原因的取值只在代码里定。

Revision ID: 3b7e2d9f4c61
Revises: 8d1e6b3f5a92
Create Date: 2026-11-01 20:00:00.000000

拆解失败多了一种原因 ``model_unavailable``（配置页里没有启用拆解模型）。``error_code`` 的取值由
``domains/references/models.py`` 的 ``BreakdownErrorCode`` 定，表上不再另写一份，以后加原因不用改表。

降级先把 ``model_unavailable`` 改记成 ``model_failed``（旧取值里同样是不值得再拆的一种），再加回原来的 CHECK。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "3b7e2d9f4c61"
down_revision: str | None = "8d1e6b3f5a92"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "reference_videos"
_CHECK = "ck_reference_videos_error_code"


def upgrade() -> None:
    op.drop_constraint(_CHECK, TABLE, type_="check", schema=SCHEMA)


def downgrade() -> None:
    op.execute(
        f"UPDATE {SCHEMA}.{TABLE} SET error_code = 'model_failed' "
        "WHERE error_code = 'model_unavailable'"
    )
    op.create_check_constraint(
        _CHECK,
        TABLE,
        "error_code IN ('video_unreadable', 'model_call_failed', 'model_failed', 'timeout')",
        schema=SCHEMA,
    )
