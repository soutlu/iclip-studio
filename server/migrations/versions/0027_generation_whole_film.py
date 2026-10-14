"""iclip.generation_jobs：视频多一种整片，是没有来源的本地拼接。

Revision ID: 3c8e5a1f9d40
Revises: 9a4d17c3e5b2
Create Date: 2026-10-14 20:00:00.000000

整片把一段对话里的几条成片剪成一条，是 video / compose，却没有来源、原作、镜号与区间，必挂对话。
视频那条组合约束多一支允许这种行；别的视频形状不变（合成仍必有来源与原作）。

存量没有整片，不回填。降级删掉整片（旧版本把没有来源的 compose 当成坏数据）：先删以它为来源的
字幕记录与以它为主语的下载事件，两者都对它有外键；再收回约束。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "3c8e5a1f9d40"
down_revision: str | None = "9a4d17c3e5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"

_VIDEO_SHAPE = "ck_generation_jobs_video_shape"
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""

_GENERATE_AND_COMPOSE = (
    "(operation = 'generate' AND source_job_id IS NULL AND root_job_id IS NULL"
    " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
    " OR (operation = 'generate' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
    " AND range_start_ms IS NOT NULL AND range_end_ms IS NOT NULL"
    " AND range_start_ms >= 0 AND range_end_ms > range_start_ms)"
    " OR (operation = 'compose' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
    " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
)
"""迁移 0020 定下的出片、编辑段与合成三种形状，两个方向都原样保留。"""

_WHOLE_FILM = (
    " OR (operation = 'compose' AND source_job_id IS NULL AND root_job_id IS NULL"
    " AND shot_index IS NULL AND range_start_ms IS NULL AND range_end_ms IS NULL"
    " AND conversation_id IS NOT NULL)"
)

_IS_WHOLE_FILM = "kind = 'video' AND operation = 'compose' AND source_job_id IS NULL"


def _video_shape(*, whole_film: bool) -> str:
    shapes = _GENERATE_AND_COMPOSE + (_WHOLE_FILM if whole_film else "")
    return f"kind <> 'video' OR (source_url IS NULL AND ({shapes} OR operation = 'upload'))"


def upgrade() -> None:
    op.drop_constraint(_VIDEO_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_VIDEO_SHAPE, TABLE, _video_shape(whole_film=True), schema=SCHEMA)


def downgrade() -> None:
    whole_films = f"SELECT id FROM {JOBS} WHERE {_IS_WHOLE_FILM}"
    op.execute(f"DELETE FROM {SCHEMA}.tracking_events WHERE job_id IN ({whole_films})")
    op.execute(f"DELETE FROM {JOBS} WHERE source_job_id IN ({whole_films})")
    op.execute(f"DELETE FROM {JOBS} WHERE {_IS_WHOLE_FILM}")
    op.drop_constraint(_VIDEO_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_VIDEO_SHAPE, TABLE, _video_shape(whole_film=False), schema=SCHEMA)
