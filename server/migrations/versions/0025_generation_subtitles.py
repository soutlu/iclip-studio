"""iclip.generation_jobs：新种类字幕记录，结果是逐句文字与时间。

Revision ID: 5e3f0b8c2d71
Revises: 21c3a0de53ab
Create Date: 2026-10-14 12:00:00.000000

``kind`` 多出 ``subtitle``：识别一条成片的口播，来源是那条视频。加一列 ``sentences``（JSONB 数组，
每句 ``{start_ms, end_ms, text, speaker}``），只有字幕记录能有，完成的字幕记录必须有；字幕记录没有
原作、区间、镜号、外部地址与产物地址。两条新 CHECK 兜底，种类那条放宽。

存量没有字幕记录，不回填。降级删掉字幕记录（旧版本读不了这种行），再收回约束与列。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "5e3f0b8c2d71"
down_revision: str | None = "21c3a0de53ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"

_KIND = "ck_generation_jobs_kind"
_OLD_KIND = "kind IN ('video', 'image')"
_NEW_KIND = "kind IN ('video', 'image', 'subtitle')"

_SUBTITLE_SHAPE = "ck_generation_jobs_subtitle_shape"
_SENTENCES = "ck_generation_jobs_sentences"
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("sentences", postgresql.JSONB(), nullable=True), schema=SCHEMA)
    op.drop_constraint(_KIND, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_KIND, TABLE, _NEW_KIND, schema=SCHEMA)
    op.create_check_constraint(
        _SUBTITLE_SHAPE,
        TABLE,
        "kind <> 'subtitle' OR (operation = 'generate' AND source_job_id IS NOT NULL"
        " AND source_url IS NULL AND root_job_id IS NULL AND shot_index IS NULL"
        " AND range_start_ms IS NULL AND range_end_ms IS NULL"
        " AND output_url IS NULL AND watermark_output_url IS NULL"
        " AND (status <> 'completed' OR sentences IS NOT NULL))",
        schema=SCHEMA,
    )
    op.create_check_constraint(
        _SENTENCES,
        TABLE,
        "sentences IS NULL OR (kind = 'subtitle' AND jsonb_typeof(sentences) = 'array')",
        schema=SCHEMA,
    )


def downgrade() -> None:
    # 字幕记录不被别的行当来源或原作引用，埋点事件只记视频，删掉不留悬空外键。
    op.execute(f"DELETE FROM {JOBS} WHERE kind = 'subtitle'")
    op.drop_constraint(_SENTENCES, TABLE, type_="check", schema=SCHEMA)
    op.drop_constraint(_SUBTITLE_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.drop_constraint(_KIND, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_KIND, TABLE, _OLD_KIND, schema=SCHEMA)
    op.drop_column(TABLE, "sentences", schema=SCHEMA)
