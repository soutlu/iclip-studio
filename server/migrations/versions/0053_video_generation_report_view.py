"""iclip：新视图 ``video_generation_report``，按条列出已结束的视频生成与是否被下载。

Revision ID: 0d745e5b43c5
Revises: 5c2a8e1f7d04
Create Date: 2026-11-06 12:00:00.000000

每行一条成功或失败的出片或编辑段。``downloaded`` 不限下载人：编辑段只看它自己，出片还算由它
产生的编辑段、合成、成片、高清版。生产库可能先手工建过同名视图，所以用 ``CREATE OR REPLACE``。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from alembic import op

revision: str = "0d745e5b43c5"
down_revision: str | None = "5c2a8e1f7d04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CREATE: Final = """
CREATE OR REPLACE VIEW iclip.video_generation_report AS
WITH downloaded AS (
    SELECT DISTINCT job_id AS id
    FROM iclip.tracking_events
    WHERE name = 'video.downloaded'
),
with_source AS (
    SELECT id FROM downloaded
    UNION
    SELECT g.source_job_id
    FROM downloaded d
    JOIN iclip.generation_jobs g ON g.id = d.id
    WHERE g.operation = 'enhance'
),
with_film AS (
    SELECT id FROM with_source
    UNION
    SELECT CAST(v ->> 'jobId' AS uuid)
    FROM with_source w
    JOIN iclip.generation_jobs g ON g.id = w.id AND g.kind = 'whole_film'
    CROSS JOIN LATERAL jsonb_array_elements(g.request -> 'videos') AS v
),
credited AS (
    SELECT id FROM with_film
    UNION
    SELECT g.root_job_id
    FROM with_film w
    JOIN iclip.generation_jobs g ON g.id = w.id
    WHERE g.root_job_id IS NOT NULL
)
SELECT
    u.email AS user_email,
    u.username AS user_name,
    g.id AS job_id,
    g.created_at AT TIME ZONE 'Asia/Shanghai' AS started_at,
    g.finished_at AT TIME ZONE 'Asia/Shanghai' AS finished_at,
    g.request ->> 'model' AS model,
    CASE g.status WHEN 'completed' THEN '成功' ELSE '失败' END AS status,
    c.id IS NOT NULL AS downloaded
FROM iclip.generation_jobs g
JOIN iclip.users u ON u.id = g.owner_user_id
LEFT JOIN credited c ON c.id = g.id
WHERE g.kind = 'video'
  AND g.operation = 'generate'
  AND g.status IN ('completed', 'failed')
"""


def upgrade() -> None:
    op.execute(_CREATE)


def downgrade() -> None:
    op.execute("DROP VIEW iclip.video_generation_report")
