"""iclip.generation_jobs：视频上传记下文件的 MD5，确认时按它认出同一个文件（ADR-0015）。

Revision ID: 602b9cec091d
Revises: a97c2445795a
Create Date: 2026-10-07 18:00:00.000000

加一列 ``content_md5``：只有视频上传行可以有，由 CHECK 兜底；桶里的对象不是一次整传
（``Normal``）时不填。再建（MD5，建立时刻）的部分索引，确认时按它找同一个文件最早的那条上传。

存量不回填：已经重复的上传各留各的地址，不合并。降级删掉索引、约束与列，记下的 MD5 随之丢掉。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "602b9cec091d"
down_revision: str | None = "a97c2445795a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"

_CHECK = "ck_generation_jobs_content_md5"
_INDEX = "ix_generation_jobs_video_upload_md5"
"""与 ``infra_sql.generation_jobs_table`` 上声明的同名同式。"""


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("content_md5", sa.Text(), nullable=True), schema=SCHEMA)
    op.create_check_constraint(
        _CHECK,
        TABLE,
        "content_md5 IS NULL OR (kind = 'video' AND operation = 'upload')",
        schema=SCHEMA,
    )
    op.create_index(
        _INDEX,
        TABLE,
        ["content_md5", "created_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("content_md5 IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX, TABLE, schema=SCHEMA)
    op.drop_constraint(_CHECK, TABLE, type_="check", schema=SCHEMA)
    op.drop_column(TABLE, "content_md5", schema=SCHEMA)
