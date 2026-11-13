"""成片记录的请求里，单个可空的 ``music`` 换成音频来源的列表 ``audios``。

Revision ID: e257badecd70
Revises: 9f3796a31ae4
Create Date: 2026-11-12 18:00:00.000000

``music`` 是 null 的换成空列表，是一条来源的换成只有它的列表。

降级换回 ``music``：取列表里的第一条，空列表是 null；多出来的音频回不来。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e257badecd70"
down_revision: str | None = "9f3796a31ae4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WHOLE_FILM = "kind = 'whole_film' AND operation = 'render'"


def upgrade() -> None:
    op.execute(
        "UPDATE iclip.generation_jobs SET request = (request - 'music') || jsonb_build_object("
        " 'audios', CASE WHEN jsonb_typeof(request -> 'music') = 'object'"
        " THEN jsonb_build_array(request -> 'music') ELSE '[]'::jsonb END)"
        f" WHERE {_WHOLE_FILM} AND request -> 'music' IS NOT NULL"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE iclip.generation_jobs SET request = (request - 'audios') || jsonb_build_object("
        " 'music', COALESCE(request -> 'audios' -> 0, 'null'::jsonb))"
        f" WHERE {_WHOLE_FILM} AND request -> 'audios' IS NOT NULL"
    )
