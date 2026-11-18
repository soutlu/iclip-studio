"""生成记录加上配置组与发给视频网关的 model_id，视频生成报表末尾跟着加两列。

Revision ID: 7d2a4c9e1f38
Revises: 5b8e2d4f7a10
Create Date: 2026-11-16 12:00:00.000000

``model_group`` 与 ``upstream_model`` 都可空：默认组的记录两列为空，历史记录不回填（都算默认组）。
报表视图只在末尾追加 ``model_group`` 与 ``upstream_model``（没记上游 model_id 时取原 ``model`` 列的值），
原有列的名字与顺序不动，审计也读这个视图。

降级先把视图换回原来的定义，再删两列。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "7d2a4c9e1f38"
down_revision: str | None = "5b8e2d4f7a10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 现行定义原样取自 data/baseline_schema.sql，{extra} 处追加新列。
_REPORT_VIEW = """CREATE OR REPLACE VIEW iclip.video_generation_report AS
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
    (c.id IS NOT NULL) AS downloaded{extra}
   FROM ((iclip.generation_jobs g
     JOIN iclip.users u ON ((u.id = g.owner_user_id)))
     LEFT JOIN credited c ON ((c.id = g.id)))
  WHERE ((g.kind = 'video'::text) AND (g.operation = 'generate'::text) AND (g.source_job_id IS NULL) AND (g.status = ANY (ARRAY['completed'::text, 'failed'::text])))"""

_GROUP_COLUMNS = """,
    g.model_group,
    COALESCE(g.upstream_model, (g.request ->> 'model'::text)) AS upstream_model"""


def upgrade() -> None:
    bind = op.get_bind()
    # 原生执行：SQLAlchemy 的 text() 会把 PostgreSQL 的 :: 转换语法当成绑定参数。
    bind.exec_driver_sql("ALTER TABLE iclip.generation_jobs ADD COLUMN model_group text")
    bind.exec_driver_sql("ALTER TABLE iclip.generation_jobs ADD COLUMN upstream_model text")
    bind.exec_driver_sql(_REPORT_VIEW.format(extra=_GROUP_COLUMNS))


def downgrade() -> None:
    bind = op.get_bind()
    # CREATE OR REPLACE VIEW 不能去掉列，先删再按原定义建。
    bind.exec_driver_sql("DROP VIEW iclip.video_generation_report")
    bind.exec_driver_sql(_REPORT_VIEW.format(extra=""))
    bind.exec_driver_sql("ALTER TABLE iclip.generation_jobs DROP COLUMN upstream_model")
    bind.exec_driver_sql("ALTER TABLE iclip.generation_jobs DROP COLUMN model_group")
