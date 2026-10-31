"""agent_runtime：运行统计按时间窗取的三种行各加一个按时刻的索引，查询成本只随窗里的行增长。

Revision ID: b7e2c94d1a3f
Revises: 62893acbf136
Create Date: 2026-10-31 12:00:00.000000

``events`` 只对开始事件（``kind = 'run_started'``）按时刻建部分索引，统计接口先用它圈出窗里开始的运行，
再按 ``idx_events_run`` 取这些运行的事件；``agent_jobs`` 按发起时刻、``conversation_usage`` 按最后一次
累加的时刻。迁移在事务里执行，建索引期间这几张表的写入要等。

降级删掉这三个索引。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e2c94d1a3f"
down_revision: str | None = "62893acbf136"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_SCHEMA = "agent_runtime"


def upgrade() -> None:
    op.create_index(
        "idx_events_run_started",
        "events",
        ["timestamp"],
        schema=RUNTIME_SCHEMA,
        postgresql_where=sa.text("kind = 'run_started'"),
    )
    op.create_index("idx_agent_jobs_created", "agent_jobs", ["created_at"], schema=RUNTIME_SCHEMA)
    op.create_index(
        "idx_conversation_usage_last", "conversation_usage", ["last_at"], schema=RUNTIME_SCHEMA
    )


def downgrade() -> None:
    op.drop_index("idx_conversation_usage_last", "conversation_usage", schema=RUNTIME_SCHEMA)
    op.drop_index("idx_agent_jobs_created", "agent_jobs", schema=RUNTIME_SCHEMA)
    op.drop_index("idx_events_run_started", "events", schema=RUNTIME_SCHEMA)
