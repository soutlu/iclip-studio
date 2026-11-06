"""iclip：``video_generation_report`` 只列出片，编辑段不再单独成行。

Revision ID: aacc58dec9ab
Revises: a4dfc0e6ca1c
Create Date: 2026-11-06 20:00:00.000000

「是否下载」的口径不变：编辑段被下载仍算给它的出片。降级写回 0053 的定义，编辑段的行回来。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from alembic import op

revision: str = "aacc58dec9ab"
down_revision: str | None = "a4dfc0e6ca1c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TAKES_ONLY: Final = """
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
  AND g.source_job_id IS NULL
  AND g.status IN ('completed', 'failed')
"""

_WITH_EDIT_SEGMENTS: Final = """
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
    op.execute(_TAKES_ONLY)


def downgrade() -> None:
    op.execute(_WITH_EDIT_SEGMENTS)
