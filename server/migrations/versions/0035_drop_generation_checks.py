"""iclip.generation_jobs：删掉种类、操作与各种行形状的 CHECK 约束。

Revision ID: b5d1e7a0c934
Revises: 44c6505380a0
Create Date: 2026-10-19 12:00:00.000000

种类与操作的规则只留在 Python 里，新增一种记录（如整片导出 ``whole_film`` / ``render``）不用再改
表结构。主键、外键与非空不变。

降级前锁表核对：有整片导出的记录就拒绝，不替它删记录；没有就按迁移 0034 时的原样把 12 条约束
加回来。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

import sqlalchemy as sa
from alembic import op

revision: str = "b5d1e7a0c934"
down_revision: str | None = "44c6505380a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"

_CHECKS: Final[dict[str, str]] = {
    "ck_generation_jobs_kind": "kind IN ('video', 'image', 'subtitle', 'audio')",
    "ck_generation_jobs_operation": "operation IN ('generate', 'compose', 'cut', 'upload')",
    "ck_generation_jobs_request": (
        "(operation IN ('cut', 'upload') AND request IS NULL)"
        " OR (operation IN ('generate', 'compose') AND request IS NOT NULL"
        " AND jsonb_typeof(request) = 'object')"
    ),
    "ck_generation_jobs_video_shape": (
        "kind <> 'video' OR (source_url IS NULL AND ("
        "(operation = 'generate' AND source_job_id IS NULL AND root_job_id IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
        " OR (operation = 'generate' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
        " AND range_start_ms IS NOT NULL AND range_end_ms IS NOT NULL"
        " AND range_start_ms >= 0 AND range_end_ms > range_start_ms)"
        " OR (operation = 'compose' AND source_job_id IS NOT NULL AND root_job_id IS NOT NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
        " OR operation = 'upload'))"
    ),
    "ck_generation_jobs_image_shape": (
        "kind <> 'image' OR (root_job_id IS NULL AND range_start_ms IS NULL"
        " AND range_end_ms IS NULL AND ("
        "(operation = 'generate' AND (source_job_id IS NULL OR source_url IS NULL))"
        " OR operation IN ('cut', 'upload')))"
    ),
    "ck_generation_jobs_cut_shape": (
        "operation <> 'cut'"
        " OR (kind = 'image' AND source_job_id IS NOT NULL AND source_url IS NULL)"
    ),
    "ck_generation_jobs_upload_shape": (
        "operation <> 'upload' OR ((conversation_id IS NULL OR kind = 'audio')"
        " AND source_job_id IS NULL"
        " AND source_url IS NULL AND root_job_id IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
    ),
    "ck_generation_jobs_settled": (
        "operation NOT IN ('cut', 'upload')"
        " OR (status = 'completed' AND output_url IS NOT NULL AND finished_at IS NOT NULL)"
    ),
    "ck_generation_jobs_content_md5": (
        "content_md5 IS NULL OR (kind = 'video' AND operation = 'upload')"
    ),
    "ck_generation_jobs_subtitle_shape": (
        "kind <> 'subtitle' OR (operation = 'generate' AND source_job_id IS NOT NULL"
        " AND source_url IS NULL AND root_job_id IS NULL AND shot_index IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL"
        " AND output_url IS NULL AND watermark_output_url IS NULL"
        " AND (status <> 'completed' OR sentences IS NOT NULL))"
    ),
    "ck_generation_jobs_sentences": (
        "sentences IS NULL OR (kind = 'subtitle' AND jsonb_typeof(sentences) = 'array')"
    ),
    "ck_generation_jobs_audio_shape": (
        "kind <> 'audio' OR (operation IN ('generate', 'upload')"
        " AND source_job_id IS NULL AND source_url IS NULL AND root_job_id IS NULL"
        " AND shot_index IS NULL AND range_start_ms IS NULL AND range_end_ms IS NULL"
        " AND watermark_output_url IS NULL"
        " AND (operation <> 'generate' OR (conversation_id IS NOT NULL"
        " AND (status <> 'completed' OR (output_url IS NOT NULL AND duration_ms IS NOT NULL)))))"
    ),
}
"""迁移 0034 时表上的 12 条约束，降级原样加回。"""


def upgrade() -> None:
    for name in _CHECKS:
        op.drop_constraint(name, TABLE, type_="check", schema=SCHEMA)


def downgrade() -> None:
    """加回约束；有整片导出的记录时拒绝降级，数据原样留着。"""

    connection = op.get_bind()
    # 核对与加约束共用这把锁，核对之后并发受理的导出进不来。
    connection.execute(sa.text(f"LOCK TABLE {SCHEMA}.{TABLE} IN ACCESS EXCLUSIVE MODE"))
    exported = connection.execute(
        sa.text(f"SELECT EXISTS (SELECT 1 FROM {SCHEMA}.{TABLE} WHERE kind = 'whole_film')")
    ).scalar_one()
    if exported:
        raise RuntimeError("有整片导出的记录，旧版本的约束不认这种行，无法无损降级到 0034")
    for name, condition in _CHECKS.items():
        op.create_check_constraint(name, TABLE, condition, schema=SCHEMA)
