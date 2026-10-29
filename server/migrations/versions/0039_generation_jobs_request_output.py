"""iclip.generation_jobs：各种记录自己的产出并进 ``output``，自己的输入并进 ``request``。

Revision ID: e7b3c91d4a26
Revises: ad8ae2f51ce1
Create Date: 2026-10-29 12:00:00.000000

只有各种记录都用到、或数据库要按它查的字段单独成列。``output_url``、``watermark_output_url``、
``duration_ms``、``content_md5``、``sentences`` 搬进 ``output``（键 ``url``、``watermark_url``、
``duration_ms``、``content_md5``、``sentences``，只放非空项，全空为 NULL）；编辑段的区间并进
``request`` 的 ``range_start_ms`` / ``range_end_ms``，帧图编辑的外部底图并进 ``request`` 的
``sourceUrl``。上传与切图不交给执行方，``provider`` 置空。原地改表，不建新表；搬完逐项核对，
对不上就回滚整个迁移。按地址、MD5、参考视频与素材片的查询各换一条对应的索引。

整表更新留下的旧行不在迁移里回收：``VACUUM FULL`` 不能在事务里跑，部署时在同一停机窗口执行。

降级完整还原：从 ``output`` / ``request`` 取回 8 列、从 ``request`` 去掉三个键，上传与切图的
``provider`` 回填为操作名，换回旧索引。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "e7b3c91d4a26"
down_revision: str | None = "ad8ae2f51ce1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"

_OLD_OUTPUT_COLUMNS: Final = (
    "output_url IS NOT NULL OR watermark_output_url IS NOT NULL OR duration_ms IS NOT NULL"
    " OR content_md5 IS NOT NULL OR sentences IS NOT NULL"
)

_MOVE: Final = f"""
UPDATE {SCHEMA}.{TABLE} SET
    output = NULLIF(
        CASE WHEN output_url IS NOT NULL
            THEN jsonb_build_object('url', output_url) ELSE '{{}}'::jsonb END
        || CASE WHEN watermark_output_url IS NOT NULL
            THEN jsonb_build_object('watermark_url', watermark_output_url) ELSE '{{}}'::jsonb END
        || CASE WHEN duration_ms IS NOT NULL
            THEN jsonb_build_object('duration_ms', duration_ms) ELSE '{{}}'::jsonb END
        || CASE WHEN content_md5 IS NOT NULL
            THEN jsonb_build_object('content_md5', content_md5) ELSE '{{}}'::jsonb END
        || CASE WHEN sentences IS NOT NULL
            THEN jsonb_build_object('sentences', sentences) ELSE '{{}}'::jsonb END,
        '{{}}'::jsonb
    ),
    request = request
        || CASE WHEN range_start_ms IS NOT NULL OR range_end_ms IS NOT NULL
            THEN jsonb_build_object('range_start_ms', range_start_ms, 'range_end_ms', range_end_ms)
            ELSE '{{}}'::jsonb END
        || CASE WHEN source_url IS NOT NULL
            THEN jsonb_build_object('sourceUrl', source_url) ELSE '{{}}'::jsonb END,
    provider = CASE WHEN operation IN ('upload', 'cut') THEN NULL ELSE provider END
"""

# NULL 的 request 遇上 ``?`` 得 NULL，用 IS NOT TRUE 让它也算没搬过去。
_VERIFY: Final = f"""
DO $$
DECLARE
    old_outputs bigint;
    new_outputs bigint;
BEGIN
    IF EXISTS (
        SELECT 1 FROM {SCHEMA}.{TABLE}
        WHERE (range_start_ms IS NOT NULL OR range_end_ms IS NOT NULL)
          AND ((request ? 'range_start_ms') IS NOT TRUE OR (request ? 'range_end_ms') IS NOT TRUE)
    ) THEN
        RAISE EXCEPTION '有区间的记录没把区间并进 request';
    END IF;
    IF EXISTS (
        SELECT 1 FROM {SCHEMA}.{TABLE}
        WHERE source_url IS NOT NULL AND (request ? 'sourceUrl') IS NOT TRUE
    ) THEN
        RAISE EXCEPTION '有外部底图的记录没把 sourceUrl 并进 request';
    END IF;
    IF EXISTS (
        SELECT 1 FROM {SCHEMA}.{TABLE} WHERE ({_OLD_OUTPUT_COLUMNS}) AND output IS NULL
    ) THEN
        RAISE EXCEPTION '有产出的记录 output 为空';
    END IF;
    SELECT count(*) INTO old_outputs FROM {SCHEMA}.{TABLE} WHERE {_OLD_OUTPUT_COLUMNS};
    SELECT count(*) INTO new_outputs FROM {SCHEMA}.{TABLE} WHERE output IS NOT NULL;
    IF old_outputs <> new_outputs THEN
        RAISE EXCEPTION 'output 非空的行数 % 与原来有产出的行数 % 不等', new_outputs, old_outputs;
    END IF;
END
$$
"""

_MOVED_COLUMNS: Final[tuple[tuple[str, sa.types.TypeEngine[Any]], ...]] = (
    ("output_url", sa.Text()),
    ("watermark_output_url", sa.Text()),
    ("duration_ms", sa.Integer()),
    ("content_md5", sa.Text()),
    ("sentences", JSONB()),
    ("source_url", sa.Text()),
    ("range_start_ms", sa.Integer()),
    ("range_end_ms", sa.Integer()),
)

_OLD_INDEXES: Final = (
    "ix_generation_jobs_conversation_created",
    "ix_generation_jobs_conversation_image_output",
    "ix_generation_jobs_video_upload_md5",
    "ix_generation_jobs_owner_created",
    "ix_generation_jobs_task_created",
)

_NEW_INDEXES: Final = (
    "ix_generation_jobs_owner_created",
    "ix_generation_jobs_conversation_kind_created",
    "ix_generation_jobs_task_created",
    "ix_generation_jobs_masters",
    "ix_generation_jobs_whole_films",
    "ix_generation_jobs_unfinished",
    "ix_generation_jobs_output_url",
    "ix_generation_jobs_video_upload_md5",
    "ix_generation_jobs_reference_trial",
)

_CREATE_NEW_INDEXES: Final = (
    f"CREATE INDEX ix_generation_jobs_owner_created ON {SCHEMA}.{TABLE}"
    " (owner_user_id, created_at, id)",
    f"CREATE INDEX ix_generation_jobs_conversation_kind_created ON {SCHEMA}.{TABLE}"
    " (conversation_id, kind, created_at, id) WHERE conversation_id IS NOT NULL",
    f"CREATE INDEX ix_generation_jobs_task_created ON {SCHEMA}.{TABLE}"
    " (task_id, created_at, id) WHERE task_id IS NOT NULL",
    f"CREATE INDEX ix_generation_jobs_masters ON {SCHEMA}.{TABLE}"
    " (conversation_id, finished_at, id)"
    " WHERE kind = 'video' AND status = 'completed' AND (output ->> 'url') IS NOT NULL"
    " AND ((operation = 'generate' AND source_job_id IS NULL) OR operation = 'compose')",
    f"CREATE INDEX ix_generation_jobs_whole_films ON {SCHEMA}.{TABLE}"
    " (conversation_id, finished_at, id)"
    " WHERE kind = 'whole_film' AND status = 'completed' AND (output ->> 'url') IS NOT NULL",
    f"CREATE INDEX ix_generation_jobs_unfinished ON {SCHEMA}.{TABLE}"
    " (conversation_id, kind) WHERE status IN ('pending', 'submitting', 'submitted')",
    f"CREATE INDEX ix_generation_jobs_output_url ON {SCHEMA}.{TABLE}"
    " USING hash ((output ->> 'url')) WHERE (output ->> 'url') IS NOT NULL",
    f"CREATE INDEX ix_generation_jobs_video_upload_md5 ON {SCHEMA}.{TABLE}"
    " ((output ->> 'content_md5'), created_at, id)"
    " WHERE kind = 'video' AND operation = 'upload'",
    f"CREATE INDEX ix_generation_jobs_reference_trial ON {SCHEMA}.{TABLE}"
    " ((metadata ->> 'referenceId'), created_at)"
    " WHERE (metadata ->> 'referenceId') IS NOT NULL",
)


def upgrade() -> None:
    for name in _OLD_INDEXES:
        op.drop_index(name, TABLE, schema=SCHEMA)
    op.add_column(TABLE, sa.Column("output", JSONB(), nullable=True), schema=SCHEMA)
    op.alter_column(TABLE, "provider", nullable=True, schema=SCHEMA)
    op.execute(_MOVE)
    op.execute(_VERIFY)
    for name, _ in _MOVED_COLUMNS:
        op.drop_column(TABLE, name, schema=SCHEMA)
    for statement in _CREATE_NEW_INDEXES:
        op.execute(statement)
    op.execute(f"ANALYZE {SCHEMA}.{TABLE}")


def downgrade() -> None:
    for name in _NEW_INDEXES:
        op.drop_index(name, TABLE, schema=SCHEMA)
    for name, type_ in _MOVED_COLUMNS:
        op.add_column(TABLE, sa.Column(name, type_, nullable=True), schema=SCHEMA)
    op.execute(
        f"""
        UPDATE {SCHEMA}.{TABLE} SET
            output_url = output ->> 'url',
            watermark_output_url = output ->> 'watermark_url',
            duration_ms = (output ->> 'duration_ms')::int,
            content_md5 = output ->> 'content_md5',
            sentences = output -> 'sentences',
            source_url = request ->> 'sourceUrl',
            range_start_ms = (request ->> 'range_start_ms')::int,
            range_end_ms = (request ->> 'range_end_ms')::int,
            request = request - 'sourceUrl' - 'range_start_ms' - 'range_end_ms',
            provider = CASE WHEN operation IN ('upload', 'cut') THEN operation ELSE provider END
        """
    )
    op.alter_column(TABLE, "provider", nullable=False, schema=SCHEMA)
    op.create_index(
        "ix_generation_jobs_owner_created", TABLE, ["owner_user_id", "created_at"], schema=SCHEMA
    )
    op.create_index(
        "ix_generation_jobs_conversation_created",
        TABLE,
        ["conversation_id", "created_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_generation_jobs_task_created", TABLE, ["task_id", "created_at"], schema=SCHEMA
    )
    op.create_index(
        "ix_generation_jobs_conversation_image_output",
        TABLE,
        ["conversation_id", "output_url"],
        schema=SCHEMA,
        postgresql_where=sa.text("kind = 'image' AND output_url IS NOT NULL"),
    )
    op.create_index(
        "ix_generation_jobs_video_upload_md5",
        TABLE,
        ["content_md5", "created_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("content_md5 IS NOT NULL"),
    )
    op.drop_column(TABLE, "output", schema=SCHEMA)
