"""参考资产分表：主表 ``iclip.references`` 加子表 ``reference_videos`` / ``reference_audios``，试生成记成
``operation='trial'``。

Revision ID: e3a95c1d7b42
Revises: b4e81c6d0f27
Create Date: 2026-11-17 18:00:00.000000

三张表上都不设外键与取值约束，种类、子类、拆解状态等取值只在应用层校验；同一地址的参考视频由
应用层按地址加咨询锁去重，代替原来的唯一约束。

升级：

1. 先查配音记录里 ``{kind:'audio', url}`` 写法的参考音频：地址对上属主一条音频上传的改写成
   ``{kind:'upload', uploadId, url}``（对上多条取最早的）；有对不上的就报错停下，什么都不改。
2. 去掉资料库条目指向参考视频的外键；旧表改名 ``reference_videos_legacy``，主键、唯一约束与列表
   索引跟着改名，让出名字。
3. 建主表、视频子表、音频子表与它们的索引。
4. 带 ``metadata.referenceId`` 的出片（没有来源的视频 ``generate``）改成 ``trial``；``metadata`` 不动。
5. 旧参考视频按原 id 搬进主表与视频子表，资料库条目与标签不用动：标题为空，``upload_id`` 取同一
   属主、同一地址最早的那条视频上传，``test_job_id`` 取这条参考视频最新的一次试生成。
6. 删旧表与试生成按 ``metadata.referenceId`` 查的索引。
7. 视频生成报表连试生成一起统计，末尾追加一列 ``trial`` 标出是不是试生成。

降级会丢数据：

- 参考音频整个丢掉；用了参考音频库或音频上传的配音记录改回 ``{kind:'audio', url}``，台词与 id 丢掉；
  成片导出记录里对上参考音频库的配乐条目删掉。
- 视频请求里的 ``reference_ids`` 删掉。
- 试生成改回 ``generate``；``test_job_id`` 指着的那条没有 ``metadata.referenceId`` 时补上。升级以后
  发起、又不是某条参考视频最新一次的试生成，降级后认不出属于哪条参考视频，成了没有对话的出片。
- 参考视频写回旧表：来源（上传、生成记录）丢掉，``api_key_id`` 取主表的。
- 报表视图删掉重建（不是原地替换），视图上另外授过的权限要重新授。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e3a95c1d7b42"
down_revision: str | None = "b4e81c6d0f27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UNMATCHED_DUBBING_AUDIO = """
SELECT count(*) FROM iclip.generation_jobs g
WHERE g.kind = 'dubbing' AND g.request -> 'reference' ->> 'kind' = 'audio'
  AND NOT EXISTS (
      SELECT 1 FROM iclip.media_uploads m
      WHERE m.kind = 'audio' AND m.owner_user_id = g.owner_user_id
        AND m.url = g.request -> 'reference' ->> 'url'
  )
"""

_DUBBING_AUDIO_TO_UPLOAD = """
UPDATE iclip.generation_jobs g
SET request = jsonb_set(g.request, '{reference}', (
    SELECT jsonb_build_object('kind', 'upload', 'uploadId', mu.id::text, 'url', mu.url)
    FROM iclip.media_uploads mu
    WHERE mu.kind = 'audio' AND mu.owner_user_id = g.owner_user_id
      AND mu.url = g.request -> 'reference' ->> 'url'
    ORDER BY mu.created_at, mu.id
    LIMIT 1
))
WHERE g.kind = 'dubbing' AND g.request -> 'reference' ->> 'kind' = 'audio'
"""

_SET_ASIDE_LEGACY = (
    "ALTER TABLE iclip.library_entries DROP CONSTRAINT library_entries_reference_id_fkey",
    "ALTER TABLE iclip.reference_videos RENAME TO reference_videos_legacy",
    "ALTER TABLE iclip.reference_videos_legacy"
    " RENAME CONSTRAINT reference_videos_pkey TO reference_videos_legacy_pkey",
    "ALTER TABLE iclip.reference_videos_legacy"
    " RENAME CONSTRAINT uq_reference_videos_video_url TO uq_reference_videos_legacy_url",
    "ALTER INDEX iclip.ix_reference_videos_listed RENAME TO ix_reference_videos_legacy_listed",
)

_CREATE_TABLES = (
    """
CREATE TABLE iclip.references (
    id            uuid PRIMARY KEY,
    kind          text NOT NULL,
    title         text NOT NULL DEFAULT '',
    description   text,
    url           text NOT NULL,
    duration_ms   integer,
    owner_user_id uuid NOT NULL,
    api_key_id    uuid,
    upload_id     uuid,
    source_job_id uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
)""",
    "CREATE INDEX ix_references_listed ON iclip.references (kind, created_at DESC, id)"
    " WHERE deleted_at IS NULL",
    "CREATE INDEX ix_references_owner ON iclip.references (owner_user_id, kind)"
    " WHERE deleted_at IS NULL",
    "CREATE INDEX ix_references_url ON iclip.references (kind, url)",
    """
CREATE TABLE iclip.reference_videos (
    reference_id     uuid PRIMARY KEY,
    breakdown_status text NOT NULL,
    error_code       text,
    document         text,
    version          integer NOT NULL DEFAULT 1,
    requested_by     uuid,
    started_at       timestamptz,
    test_job_id      uuid,
    meta             jsonb NOT NULL DEFAULT '{}'::jsonb
)""",
    "CREATE INDEX ix_reference_videos_running ON iclip.reference_videos (started_at)"
    " WHERE breakdown_status = 'running'",
    """
CREATE TABLE iclip.reference_audios (
    reference_id uuid PRIMARY KEY,
    audio_kind   text NOT NULL,
    locale       text,
    transcript   text,
    meta         jsonb NOT NULL DEFAULT '{}'::jsonb
)""",
    "CREATE INDEX ix_reference_audios_kind ON iclip.reference_audios (audio_kind, reference_id)",
)

_MARK_TRIALS = """
UPDATE iclip.generation_jobs SET operation = 'trial'
WHERE kind = 'video' AND operation = 'generate' AND source_job_id IS NULL
  AND (metadata ->> 'referenceId') IS NOT NULL
"""

_MOVE_REFERENCES = """
INSERT INTO iclip.references
    (id, kind, title, url, owner_user_id, api_key_id, upload_id, created_at, updated_at,
     deleted_at)
SELECT rv.id, 'video', '', rv.video_url, rv.owner_user_id, rv.api_key_id, u.id, rv.created_at,
       rv.updated_at, rv.deleted_at
FROM iclip.reference_videos_legacy rv
LEFT JOIN LATERAL (
    SELECT mu.id FROM iclip.media_uploads mu
    WHERE mu.kind = 'video' AND mu.url = rv.video_url AND mu.owner_user_id = rv.owner_user_id
    ORDER BY mu.created_at, mu.id
    LIMIT 1
) u ON TRUE
"""

_MOVE_VIDEOS = """
INSERT INTO iclip.reference_videos
    (reference_id, breakdown_status, error_code, document, version, requested_by, started_at,
     test_job_id)
SELECT rv.id, rv.breakdown_status, rv.error_code, rv.document, rv.version, rv.requested_by,
       rv.started_at, trial.id
FROM iclip.reference_videos_legacy rv
LEFT JOIN LATERAL (
    SELECT g.id FROM iclip.generation_jobs g
    WHERE g.kind = 'video' AND g.operation = 'trial'
      AND (g.metadata ->> 'referenceId') = rv.id::text
    ORDER BY g.created_at DESC, g.id DESC
    LIMIT 1
) trial ON TRUE
"""

_TRIAL_INDEX = (
    "CREATE INDEX ix_generation_jobs_reference_trial ON iclip.generation_jobs"
    " USING btree (((metadata ->> 'referenceId'::text)), created_at)"
    " WHERE ((metadata ->> 'referenceId'::text) IS NOT NULL)"
)

# 现行定义原样取自 0006_generation_model_groups，{operations} 与 {extra} 处是这次改的地方。
_REPORT_VIEW = """VIEW iclip.video_generation_report AS
 WITH downloaded AS (
         SELECT DISTINCT tracking_events.job_id AS id
           FROM iclip.tracking_events
          WHERE (tracking_events.name = 'video.downloaded'::text)
        ), with_source AS (
         SELECT downloaded.id
           FROM downloaded
        UNION
         SELECT g_1.source_job_id
           FROM (downloaded d
             JOIN iclip.generation_jobs g_1 ON ((g_1.id = d.id)))
          WHERE (g_1.operation = 'enhance'::text)
        ), with_film AS (
         SELECT with_source.id
           FROM with_source
        UNION
         SELECT ((v.value ->> 'jobId'::text))::uuid AS uuid
           FROM ((with_source w
             JOIN iclip.generation_jobs g_1 ON (((g_1.id = w.id) AND (g_1.kind = 'whole_film'::text))))
             CROSS JOIN LATERAL jsonb_array_elements((g_1.request -> 'videos'::text)) v(value))
        ), credited AS (
         SELECT with_film.id
           FROM with_film
        UNION
         SELECT g_1.root_job_id
           FROM (with_film w
             JOIN iclip.generation_jobs g_1 ON ((g_1.id = w.id)))
          WHERE (g_1.root_job_id IS NOT NULL)
        )
 SELECT u.email AS user_email,
    u.username AS user_name,
    g.id AS job_id,
    (g.created_at AT TIME ZONE 'Asia/Shanghai'::text) AS started_at,
    (g.finished_at AT TIME ZONE 'Asia/Shanghai'::text) AS finished_at,
    (g.request ->> 'model'::text) AS model,
        CASE g.status
            WHEN 'completed'::text THEN '成功'::text
            ELSE '失败'::text
        END AS status,
    (c.id IS NOT NULL) AS downloaded,
    g.model_group,
    COALESCE(g.upstream_model, (g.request ->> 'model'::text)) AS upstream_model{extra}
   FROM ((iclip.generation_jobs g
     JOIN iclip.users u ON ((u.id = g.owner_user_id)))
     LEFT JOIN credited c ON ((c.id = g.id)))
  WHERE ((g.kind = 'video'::text) AND {operations} AND (g.source_job_id IS NULL) AND (g.status = ANY (ARRAY['completed'::text, 'failed'::text])))"""

_REPORT_WITH_TRIALS = "CREATE OR REPLACE " + _REPORT_VIEW.format(
    operations="(g.operation = ANY (ARRAY['generate'::text, 'trial'::text]))",
    extra=",\n    (g.operation = 'trial'::text) AS trial",
)

_REPORT_WITHOUT_TRIALS = "CREATE " + _REPORT_VIEW.format(
    operations="(g.operation = 'generate'::text)", extra=""
)

_DROP_REFERENCE_AUDIOS_FROM_EXPORTS = """
UPDATE iclip.generation_jobs g
SET request = jsonb_set(g.request, '{audios}', COALESCE((
    SELECT jsonb_agg(a.elem ORDER BY a.position)
    FROM jsonb_array_elements(g.request -> 'audios') WITH ORDINALITY AS a(elem, position)
    WHERE a.elem ->> 'sourceKind' <> 'reference'
), '[]'::jsonb))
WHERE g.kind = 'whole_film' AND g.operation = 'render'
  AND jsonb_typeof(g.request -> 'audios') = 'array'
"""

_DUBBING_BACK_TO_AUDIO = """
UPDATE iclip.generation_jobs
SET request = jsonb_set(request, '{reference}', jsonb_build_object(
        'kind', 'audio', 'url', request -> 'reference' ->> 'url'))
WHERE kind = 'dubbing' AND request -> 'reference' ->> 'kind' IN ('reference_audio', 'upload')
"""

_STRIP_REFERENCE_IDS = """
UPDATE iclip.generation_jobs SET request = request - 'reference_ids'
WHERE kind = 'video' AND request ? 'reference_ids'
"""

_TAG_TRIALS_BACK = """
UPDATE iclip.generation_jobs g
SET metadata = COALESCE(g.metadata, '{}'::jsonb)
               || jsonb_build_object('referenceId', v.reference_id::text)
FROM iclip.reference_videos v
WHERE g.id = v.test_job_id AND NOT (COALESCE(g.metadata, '{}'::jsonb) ? 'referenceId')
"""

_RESTORE_LEGACY = (
    "ALTER TABLE iclip.reference_videos RENAME TO reference_videos_split",
    "ALTER TABLE iclip.reference_videos_split"
    " RENAME CONSTRAINT reference_videos_pkey TO reference_videos_split_pkey",
    """
CREATE TABLE iclip.reference_videos (
    id uuid NOT NULL,
    video_url text NOT NULL,
    owner_user_id uuid NOT NULL,
    breakdown_status text NOT NULL,
    error_code text,
    document text,
    version integer DEFAULT 1 NOT NULL,
    requested_by uuid,
    api_key_id uuid,
    started_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT ck_reference_videos_status CHECK ((breakdown_status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT reference_videos_pkey PRIMARY KEY (id),
    CONSTRAINT uq_reference_videos_video_url UNIQUE (video_url),
    CONSTRAINT fk_reference_videos_owner FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id)
)""",
    "CREATE INDEX ix_reference_videos_listed ON iclip.reference_videos"
    " USING btree (created_at DESC, id) WHERE (deleted_at IS NULL)",
    """
INSERT INTO iclip.reference_videos
    (id, video_url, owner_user_id, breakdown_status, error_code, document, version,
     requested_by, api_key_id, started_at, created_at, updated_at, deleted_at)
SELECT r.id, r.url, r.owner_user_id, v.breakdown_status, v.error_code, v.document, v.version,
       v.requested_by, r.api_key_id, v.started_at, r.created_at, r.updated_at, r.deleted_at
FROM iclip.references r
JOIN iclip.reference_videos_split v ON v.reference_id = r.id
WHERE r.kind = 'video'
""",
    "ALTER TABLE ONLY iclip.library_entries ADD CONSTRAINT library_entries_reference_id_fkey"
    " FOREIGN KEY (reference_id) REFERENCES iclip.reference_videos(id) ON DELETE CASCADE",
    "DROP TABLE iclip.reference_videos_split",
    "DROP TABLE iclip.reference_audios",
    "DROP TABLE iclip.references",
)


def upgrade() -> None:
    bind = op.get_bind()
    # 原生执行：SQLAlchemy 的 text() 会把 PostgreSQL 的 :: 转换语法当成绑定参数。
    unmatched = bind.exec_driver_sql(_UNMATCHED_DUBBING_AUDIO).scalar_one()
    if unmatched != 0:
        raise RuntimeError(
            f"还有 {unmatched} 条配音记录的参考音频对不上属主的音频上传，没法改写，迁移停下"
        )
    bind.exec_driver_sql(_DUBBING_AUDIO_TO_UPLOAD)
    for statement in (*_SET_ASIDE_LEGACY, *_CREATE_TABLES):
        bind.exec_driver_sql(statement)
    bind.exec_driver_sql(_MARK_TRIALS)
    bind.exec_driver_sql(_MOVE_REFERENCES)
    bind.exec_driver_sql(_MOVE_VIDEOS)
    bind.exec_driver_sql("DROP TABLE iclip.reference_videos_legacy")
    bind.exec_driver_sql("DROP INDEX IF EXISTS iclip.ix_generation_jobs_reference_trial")
    bind.exec_driver_sql(_REPORT_WITH_TRIALS)


def downgrade() -> None:
    bind = op.get_bind()
    # CREATE OR REPLACE VIEW 不能去掉列，先删再按原定义建。
    bind.exec_driver_sql("DROP VIEW iclip.video_generation_report")
    bind.exec_driver_sql(_REPORT_WITHOUT_TRIALS)
    bind.exec_driver_sql(_DROP_REFERENCE_AUDIOS_FROM_EXPORTS)
    bind.exec_driver_sql(_DUBBING_BACK_TO_AUDIO)
    bind.exec_driver_sql(_STRIP_REFERENCE_IDS)
    bind.exec_driver_sql(_TAG_TRIALS_BACK)
    bind.exec_driver_sql(
        "UPDATE iclip.generation_jobs SET operation = 'generate' WHERE operation = 'trial'"
    )
    bind.exec_driver_sql(_TRIAL_INDEX)
    for statement in _RESTORE_LEGACY:
        bind.exec_driver_sql(statement)
