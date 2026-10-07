"""iclip.generation_jobs：合成的来源改记基底那一版，``request.segments`` 每段补上出自哪条记录。

Revision ID: a97c2445795a
Revises: 4acae9f7b988
Create Date: 2026-10-07 10:00:00.000000

过去合成只认一条编辑段，来源是那条编辑段，各段由服务端按它的基底与区间算出来，只存了地址。现在
合成收基底加一串片段（ADR-0010 第 4 条），来源是基底，各段的出处记在 ``request.segments`` 每段的
``sourceJobId`` 上。存量合成的来源改成它那条编辑段的来源，也就是基底；各段按地址认出处：对上基底
的产物地址填基底 id，对上编辑段的产物地址填编辑段 id。原作与镜号本来就随基底，不动。

先核对，任何一条对不上就带合成的 id 报错、整个迁移回滚：来源不是一条有来源的视频 generate（编辑
段）、``request.segments`` 不是非空数组、某段不是带字符串 ``url`` 的对象、某段的地址既对不上基底
也对不上编辑段、或者两个都对得上（基底与编辑段同一个地址，说不清是哪条）。

不可逆的部分：降级把来源写回那条编辑段、擦掉各段的 ``sourceJobId``。0022 之后的合成可以只用基底
（裁剪、删段），也可以夹进几条编辑段，旧形状只表达得了「恰好一条编辑段」；有不是这样的合成就
拒绝降级。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a97c2445795a"
down_revision: str | None = "4acae9f7b988"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "generation_jobs"
JOBS = f"{SCHEMA}.{TABLE}"

_COMPOSITE = "m.kind = 'video' AND m.operation = 'compose'"


def upgrade() -> None:
    _check_existing_rows()
    # 一条语句里 SET 的各个表达式与 FROM 的连接都看改之前的行：各段按旧来源（编辑段）与它的来源
    # （基底）认出处，同时把来源换成基底。WITH ORDINALITY 保住段的先后。
    op.execute(
        f"""
        UPDATE {JOBS} AS m
        SET request = jsonb_set(
                m.request,
                '{{segments}}',
                (
                    SELECT jsonb_agg(
                        s.segment || jsonb_build_object(
                            'sourceJobId',
                            CASE WHEN s.segment->>'url' = b.output_url THEN b.id ELSE e.id END::text
                        )
                        ORDER BY s.position
                    )
                    FROM jsonb_array_elements(m.request->'segments')
                        WITH ORDINALITY AS s(segment, position)
                )
            ),
            source_job_id = b.id
        FROM {JOBS} AS e, {JOBS} AS b
        WHERE {_COMPOSITE} AND e.id = m.source_job_id AND b.id = e.source_job_id
        """
    )


def _check_existing_rows() -> None:
    """回填依赖的形状逐条核对；认不出出处的段不静默填成哪一条。"""

    # CASE 保证先判形状再展开数组：类型不对时不能让整个迁移以函数报错崩掉，要点名是哪一行。
    _require_empty(
        f"""
        SELECT m.id FROM {JOBS} AS m
        LEFT JOIN {JOBS} AS e ON e.id = m.source_job_id
        WHERE {_COMPOSITE}
          AND NOT CASE
              WHEN e.kind = 'video' AND e.operation = 'generate' AND e.source_job_id IS NOT NULL
               AND jsonb_typeof(m.request->'segments') = 'array'
              THEN jsonb_array_length(m.request->'segments') > 0
               AND NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(m.request->'segments') AS s(segment)
                   WHERE jsonb_typeof(s.segment) IS DISTINCT FROM 'object'
                      OR jsonb_typeof(s.segment->'url') IS DISTINCT FROM 'string'
               )
              ELSE false
          END
        """,
        "合成的来源不是编辑段，或 request.segments 不是一串带地址的段，先人工处理",
    )
    _require_empty(
        f"""
        SELECT m.id FROM {JOBS} AS m
        JOIN {JOBS} AS e ON e.id = m.source_job_id
        JOIN {JOBS} AS b ON b.id = e.source_job_id
        WHERE {_COMPOSITE}
          AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(m.request->'segments') AS s(segment)
              WHERE COALESCE(s.segment->>'url' = b.output_url, false)
                  = COALESCE(s.segment->>'url' = e.output_url, false)
          )
        """,
        "合成有段的地址对不上基底或编辑段的产物（或两个都对得上），先人工处理",
    )


def downgrade() -> None:
    """来源写回各段里唯一那条不是基底的记录（编辑段），各段擦掉 ``sourceJobId``。"""

    # 旧形状只认「基底加恰好一条基于它的编辑段」：只用基底的、夹进几条编辑段的、那条不是基于
    # 这个基底的编辑段，都写不回去。
    _require_empty(
        f"""
        WITH edits AS (
            SELECT m.id, array_agg(DISTINCT s.segment->>'sourceJobId') AS ids
            FROM {JOBS} AS m, jsonb_array_elements(m.request->'segments') AS s(segment)
            WHERE {_COMPOSITE}
              AND s.segment->>'sourceJobId' IS DISTINCT FROM m.source_job_id::text
            GROUP BY m.id
        )
        SELECT m.id FROM {JOBS} AS m
        LEFT JOIN edits AS x ON x.id = m.id
        WHERE {_COMPOSITE}
          AND (
              cardinality(x.ids) = 1
              AND EXISTS (
                  SELECT 1 FROM {JOBS} AS e
                  WHERE e.id::text = x.ids[1] AND e.kind = 'video' AND e.operation = 'generate'
                    AND e.source_job_id = m.source_job_id
              )
          ) IS NOT TRUE
        """,
        "合成不是「基底加恰好一条基于它的编辑段」，旧形状表达不了，拒绝降级",
    )
    op.execute(
        f"""
        UPDATE {JOBS} AS m
        SET source_job_id = (
                SELECT DISTINCT (s.segment->>'sourceJobId')::uuid
                FROM jsonb_array_elements(m.request->'segments') AS s(segment)
                WHERE s.segment->>'sourceJobId' <> m.source_job_id::text
            ),
            request = jsonb_set(
                m.request,
                '{{segments}}',
                (
                    SELECT jsonb_agg(s.segment - 'sourceJobId' ORDER BY s.position)
                    FROM jsonb_array_elements(m.request->'segments')
                        WITH ORDINALITY AS s(segment, position)
                )
            )
        WHERE {_COMPOSITE}
        """
    )


def _require_empty(query: str, message: str) -> None:
    found = op.get_bind().execute(sa.text(query)).scalars().all()
    if found:
        raise RuntimeError(f"{message}：{[str(item) for item in found]}")
