"""iclip.generation_jobs：新种类音频记录，用户上传的音乐与生成的背景音乐。

Revision ID: 9a4d17c3e5b2
Revises: 5e3f0b8c2d71
Create Date: 2026-10-14 18:00:00.000000

``kind`` 多出 ``audio``，两种操作：上传（upload，沿用上传那几条约束：没有请求、不挂对话、创建即
完成）与生成背景音乐（generate，挂对话，完成了必有产物地址与时长）。两种都没有来源、原作、区间、
镜号、外部地址与水印地址；逐句结果与 MD5 已由各自的约束挡在别的种类之外。一条新 CHECK 兜底，
种类那条放宽。

存量没有音频记录，不回填。降级删掉音频记录（旧版本读不了这种行），再收回约束。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "9a4d17c3e5b2"
down_revision: str | None = "5e3f0b8c2d71"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"

_KIND = "ck_generation_jobs_kind"
_OLD_KIND = "kind IN ('video', 'image', 'subtitle')"
_NEW_KIND = "kind IN ('video', 'image', 'subtitle', 'audio')"

_AUDIO_SHAPE = "ck_generation_jobs_audio_shape"
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""


def upgrade() -> None:
    op.drop_constraint(_KIND, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_KIND, TABLE, _NEW_KIND, schema=SCHEMA)
    op.create_check_constraint(
        _AUDIO_SHAPE,
        TABLE,
        "kind <> 'audio' OR (operation IN ('generate', 'upload')"
        " AND source_job_id IS NULL AND source_url IS NULL AND root_job_id IS NULL"
        " AND shot_index IS NULL AND range_start_ms IS NULL AND range_end_ms IS NULL"
        " AND watermark_output_url IS NULL"
        " AND (operation <> 'generate' OR (conversation_id IS NOT NULL"
        " AND (status <> 'completed' OR (output_url IS NOT NULL AND duration_ms IS NOT NULL)))))",
        schema=SCHEMA,
    )


def downgrade() -> None:
    # 音频记录不被别的行当来源或原作引用，埋点事件只记视频，删掉不留悬空外键。
    op.execute(f"DELETE FROM {JOBS} WHERE kind = 'audio'")
    op.drop_constraint(_AUDIO_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.drop_constraint(_KIND, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_KIND, TABLE, _OLD_KIND, schema=SCHEMA)
