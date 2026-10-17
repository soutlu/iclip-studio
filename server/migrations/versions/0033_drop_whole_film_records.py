"""iclip.generation_jobs：删掉旧整片记录，视频不再有没有来源的 compose。

Revision ID: e82dd7339835
Revises: 529b24b8d9d4
Create Date: 2026-10-17 18:00:00.000000

整片改成服务端草稿加导出，导出不建生成记录（ADR-0003），已有的整片记录全部删除。对它们有外键的
先删：以整片为主语的下载事件，以整片为来源的字幕记录；再删整片本身，最后从视频那条组合约束里去掉
整片那一支，回到迁移 0020 的出片、编辑段与合成三种形状。

降级只把约束那一支加回来，删掉的整片、字幕记录与下载事件回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e82dd7339835"
down_revision: str | None = "529b24b8d9d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"

_VIDEO_SHAPE = "ck_generation_jobs_video_shape"
"""与 ``generation.infra_sql.generation_jobs_table`` 上声明的同名同式。"""

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
"""迁移 0027 加的整片那一支。"""

_IS_WHOLE_FILM = "kind = 'video' AND operation = 'compose' AND source_job_id IS NULL"


def _video_shape(*, whole_film: bool) -> str:
    shapes = _GENERATE_AND_COMPOSE + (_WHOLE_FILM if whole_film else "")
    return f"kind <> 'video' OR (source_url IS NULL AND ({shapes} OR operation = 'upload'))"


def upgrade() -> None:
    """删整片与对它有外键的行，再收回约束。"""

    whole_films = f"SELECT id FROM {JOBS} WHERE {_IS_WHOLE_FILM}"
    op.execute(f"DELETE FROM {SCHEMA}.tracking_events WHERE job_id IN ({whole_films})")
    op.execute(f"DELETE FROM {JOBS} WHERE source_job_id IN ({whole_films})")
    op.execute(f"DELETE FROM {JOBS} WHERE {_IS_WHOLE_FILM}")
    op.drop_constraint(_VIDEO_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_VIDEO_SHAPE, TABLE, _video_shape(whole_film=False), schema=SCHEMA)


def downgrade() -> None:
    """只把整片那一支加回约束；删掉的数据不恢复。"""

    op.drop_constraint(_VIDEO_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_VIDEO_SHAPE, TABLE, _video_shape(whole_film=True), schema=SCHEMA)
