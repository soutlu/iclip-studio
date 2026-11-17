"""上传台账从生成记录里拆出来：新表 ``iclip.media_uploads``，生成记录不再有 ``operation='upload'``。

Revision ID: b4e81c6d0f27
Revises: c84e19a3b502
Create Date: 2026-11-17 12:00:00.000000

表上不设外键与取值约束，种类等业务取值只在应用层校验。

升级：

1. 建 ``media_uploads`` 与它的四个索引。
2. 先查还指着上传记录、这里没法改写的引用：``root_job_id``、不是改图的 ``source_job_id``、
   ``library_entries.job_id``。有就报错停下，什么都不改（资料库条目的外键会级联删掉标签，不能等它）。
3. 把 ``generation_jobs`` 里有地址的 ``operation='upload'`` 记录搬进 ``media_uploads``，id 不变；
   内容类型、大小、宽高、时长旧记录里没有，留空。
4. 成片导出记录 ``request.audios`` 的每条 ``{jobId, url}`` 改写成 ``{sourceKind, sourceId, url}``：
   id 是一条上传的记 ``upload``，否则记 ``generation``。
5. 以上传为基底的改图记录改成外链基底的写法：``source_job_id`` 置空，基底地址写进
   ``request.sourceUrl``。
6. 指着上传记录的下载事件删掉：上传不再是生成记录，这些事件本来就不计数。
7. 删掉这些上传记录与上传的 MD5 索引。

降级会丢数据：把台账里的每一条（含升级后新传的）按旧形状写回生成记录（``completed``、
``finished_at`` 取建立时间、``output`` 只有地址与 MD5），台账里多出来的类型、大小、宽高、时长与
挂对话以外的信息丢掉；导出记录的 ``audios`` 改回 ``{jobId, url}``；``request.sourceUrl`` 正好是同一
属主一条图片上传地址的改图记录，改回指着最早那条上传、去掉 ``sourceUrl``；建回 MD5 索引后删表。
删掉的下载事件回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b4e81c6d0f27"
down_revision: str | None = "c84e19a3b502"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CREATE_TABLE = """
CREATE TABLE iclip.media_uploads (
    id              uuid PRIMARY KEY,
    owner_user_id   uuid NOT NULL,
    api_key_id      uuid,
    conversation_id uuid,
    kind            text NOT NULL,
    url             text NOT NULL,
    content_type    text,
    size_bytes      bigint,
    duration_ms     integer,
    width           integer,
    height          integer,
    content_md5     text,
    meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
)
"""

_CREATE_INDEXES = (
    "CREATE INDEX ix_media_uploads_dedup ON iclip.media_uploads"
    " (kind, content_md5, created_at, id) WHERE content_md5 IS NOT NULL",
    "CREATE INDEX ix_media_uploads_owner ON iclip.media_uploads"
    " (owner_user_id, kind, created_at DESC, id)",
    "CREATE INDEX ix_media_uploads_conversation ON iclip.media_uploads"
    " (conversation_id, kind, created_at DESC, id) WHERE conversation_id IS NOT NULL",
    "CREATE INDEX ix_media_uploads_url ON iclip.media_uploads USING hash (url)",
)

_UPLOAD_MD5_INDEX = (
    "CREATE INDEX ix_generation_jobs_video_upload_md5 ON iclip.generation_jobs"
    " USING btree (((output ->> 'content_md5'::text)), created_at, id)"
    " WHERE ((kind = 'video'::text) AND (operation = 'upload'::text))"
)

# 每条：(说明, 数出这类引用条数的 SQL)；有一条不为 0 就停下。
_UNMOVABLE = (
    (
        "原作 root_job_id 指着上传记录的生成记录",
        "SELECT count(*) FROM iclip.generation_jobs g"
        " JOIN iclip.generation_jobs u ON u.id = g.root_job_id WHERE u.operation = 'upload'",
    ),
    (
        "来源 source_job_id 指着上传记录、又不是改图的生成记录",
        "SELECT count(*) FROM iclip.generation_jobs g"
        " JOIN iclip.generation_jobs u ON u.id = g.source_job_id"
        " WHERE u.operation = 'upload' AND NOT (g.kind = 'image' AND g.operation = 'generate')",
    ),
    (
        "指着上传记录的资料库条目",
        "SELECT count(*) FROM iclip.library_entries e"
        " JOIN iclip.generation_jobs u ON u.id = e.job_id WHERE u.operation = 'upload'",
    ),
)

_MOVE_UPLOADS = """
INSERT INTO iclip.media_uploads
    (id, owner_user_id, api_key_id, conversation_id, kind, url, content_md5, created_at)
SELECT id, owner_user_id, api_key_id, conversation_id, kind, output ->> 'url',
       output ->> 'content_md5', created_at
FROM iclip.generation_jobs
WHERE operation = 'upload' AND (output ->> 'url') IS NOT NULL
"""

_AUDIO_SOURCES = """
UPDATE iclip.generation_jobs g
SET request = jsonb_set(g.request, '{audios}', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
        'sourceKind', CASE WHEN mu.id IS NOT NULL THEN 'upload' ELSE 'generation' END,
        'sourceId', a.elem ->> 'jobId',
        'url', a.elem ->> 'url') ORDER BY a.position)
    FROM jsonb_array_elements(g.request -> 'audios') WITH ORDINALITY AS a(elem, position)
    LEFT JOIN iclip.media_uploads mu ON mu.id = (a.elem ->> 'jobId')::uuid
), '[]'::jsonb))
WHERE g.kind = 'whole_film' AND g.operation = 'render'
  AND jsonb_typeof(g.request -> 'audios') = 'array'
"""

_UNLINK_IMAGE_BASES = """
UPDATE iclip.generation_jobs g
SET request = jsonb_set(
        COALESCE(g.request, '{}'::jsonb), '{sourceUrl}', to_jsonb(u.output ->> 'url')
    ),
    source_job_id = NULL
FROM iclip.generation_jobs u
WHERE g.source_job_id = u.id AND u.operation = 'upload' AND (u.output ->> 'url') IS NOT NULL
"""

_DROP_UPLOAD_DOWNLOADS = """
DELETE FROM iclip.tracking_events
WHERE job_id IN (SELECT id FROM iclip.generation_jobs WHERE operation = 'upload')
"""

_RESTORE_UPLOADS = """
INSERT INTO iclip.generation_jobs
    (id, owner_user_id, api_key_id, conversation_id, kind, operation, status,
     created_at, finished_at, output)
SELECT m.id, m.owner_user_id, m.api_key_id, m.conversation_id, m.kind, 'upload', 'completed',
       m.created_at, m.created_at,
       jsonb_strip_nulls(jsonb_build_object('url', m.url, 'content_md5', m.content_md5))
FROM iclip.media_uploads m
"""

_RESTORE_AUDIO_SOURCES = """
UPDATE iclip.generation_jobs g
SET request = jsonb_set(g.request, '{audios}', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('jobId', a.elem ->> 'sourceId', 'url', a.elem ->> 'url')
                     ORDER BY a.position)
    FROM jsonb_array_elements(g.request -> 'audios') WITH ORDINALITY AS a(elem, position)
), '[]'::jsonb))
WHERE g.kind = 'whole_film' AND g.operation = 'render'
  AND jsonb_typeof(g.request -> 'audios') = 'array'
"""

_RELINK_IMAGE_BASES = """
UPDATE iclip.generation_jobs g
SET source_job_id = m.id, request = g.request - 'sourceUrl'
FROM (
    SELECT DISTINCT ON (owner_user_id, url) id, owner_user_id, url
    FROM iclip.media_uploads
    WHERE kind = 'image'
    ORDER BY owner_user_id, url, created_at, id
) m
WHERE g.kind = 'image' AND g.operation = 'generate' AND g.source_job_id IS NULL
  AND g.owner_user_id = m.owner_user_id AND g.request ->> 'sourceUrl' = m.url
"""


def upgrade() -> None:
    bind = op.get_bind()
    # 原生执行：SQLAlchemy 的 text() 会把 PostgreSQL 的 :: 转换语法当成绑定参数。
    bind.exec_driver_sql(_CREATE_TABLE)
    for statement in _CREATE_INDEXES:
        bind.exec_driver_sql(statement)
    blocked = [
        f"{what} {count} 条"
        for what, query in _UNMOVABLE
        if (count := bind.exec_driver_sql(query).scalar_one()) != 0
    ]
    if blocked:
        raise RuntimeError(f"还有指着上传记录、没法改写的数据，迁移停下：{'；'.join(blocked)}")
    bind.exec_driver_sql(_MOVE_UPLOADS)
    bind.exec_driver_sql(_AUDIO_SOURCES)
    bind.exec_driver_sql(_UNLINK_IMAGE_BASES)
    bind.exec_driver_sql(_DROP_UPLOAD_DOWNLOADS)
    bind.exec_driver_sql("DELETE FROM iclip.generation_jobs WHERE operation = 'upload'")
    bind.exec_driver_sql("DROP INDEX IF EXISTS iclip.ix_generation_jobs_video_upload_md5")


def downgrade() -> None:
    bind = op.get_bind()
    bind.exec_driver_sql(_RESTORE_UPLOADS)
    bind.exec_driver_sql(_RESTORE_AUDIO_SOURCES)
    bind.exec_driver_sql(_RELINK_IMAGE_BASES)
    bind.exec_driver_sql(_UPLOAD_MD5_INDEX)
    bind.exec_driver_sql("DROP TABLE iclip.media_uploads")
