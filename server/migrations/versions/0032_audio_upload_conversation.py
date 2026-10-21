"""iclip.generation_jobs：上传的音乐可以挂到对话上。

Revision ID: 529b24b8d9d4
Revises: a38f28430ec1
Create Date: 2026-10-17 12:10:00.000000

上传那条约束原来不许任何上传挂对话，现在音乐（``kind = 'audio'``）可以挂，图片与视频照旧不许；
其余几项（没有来源、外部地址、原作与区间）不变。存量没有挂对话的上传，不回填。
降级前锁表核对：有挂了对话的音乐上传就拒绝，不替它抹掉对话归属。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "529b24b8d9d4"
down_revision: str | None = "a38f28430ec1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"

_UPLOAD_SHAPE = "ck_generation_jobs_upload_shape"
"""与 ``generation.infra_sql.generation_jobs_table`` 上声明的同名同式。"""

_OLD_UPLOAD_SHAPE = (
    "operation <> 'upload' OR (conversation_id IS NULL AND source_job_id IS NULL"
    " AND source_url IS NULL AND root_job_id IS NULL"
    " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
)
_NEW_UPLOAD_SHAPE = (
    "operation <> 'upload' OR ((conversation_id IS NULL OR kind = 'audio')"
    " AND source_job_id IS NULL"
    " AND source_url IS NULL AND root_job_id IS NULL"
    " AND range_start_ms IS NULL AND range_end_ms IS NULL)"
)


def upgrade() -> None:
    """放宽上传约束：音乐上传可以带对话。"""

    op.drop_constraint(_UPLOAD_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_UPLOAD_SHAPE, TABLE, _NEW_UPLOAD_SHAPE, schema=SCHEMA)


def downgrade() -> None:
    """收回约束；有挂了对话的音乐上传时拒绝降级，数据原样留着。"""

    connection = op.get_bind()
    # 核对与改约束共用这把锁，核对之后并发确认的上传进不来。
    connection.execute(sa.text("LOCK TABLE iclip.generation_jobs IN ACCESS EXCLUSIVE MODE"))
    attached = connection.execute(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM iclip.generation_jobs"
            " WHERE operation = 'upload' AND conversation_id IS NOT NULL)"
        )
    ).scalar_one()
    if attached:
        raise RuntimeError("有挂到对话上的音乐上传，旧版本不认这种行，无法无损降级到 0031")
    op.drop_constraint(_UPLOAD_SHAPE, TABLE, type_="check", schema=SCHEMA)
    op.create_check_constraint(_UPLOAD_SHAPE, TABLE, _OLD_UPLOAD_SHAPE, schema=SCHEMA)
