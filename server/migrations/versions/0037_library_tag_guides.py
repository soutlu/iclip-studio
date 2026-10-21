"""iclip：移除内容结构的旧默认判断说明，保留治理者自定义的说明。

Revision ID: a6e8d20c4f91
Revises: 7f3c2a9d1e64
Create Date: 2026-10-21 13:00:00.000000

层级选项由 JSON Schema 表达，不再指示模型优先只选小类。
仅清空名称与旧默认说明均匹配的根维度；降级只回退该维度仍为空字符串的说明。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

import sqlalchemy as sa
from alembic import op

revision: str = "a6e8d20c4f91"
down_revision: str | None = "7f3c2a9d1e64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_GUIDE: Final = "选最贴切的小类，小类都不贴切时选大类"

_UPDATE_GUIDE = sa.text(
    "UPDATE iclip.library_tags SET guide = :replacement, updated_at = now()"
    " WHERE parent_id IS NULL AND name = :name AND guide = :previous"
)


def upgrade() -> None:
    op.get_bind().execute(
        _UPDATE_GUIDE,
        {"name": "内容结构", "previous": _OLD_GUIDE, "replacement": ""},
    )


def downgrade() -> None:
    op.get_bind().execute(
        _UPDATE_GUIDE,
        {"name": "内容结构", "previous": "", "replacement": _OLD_GUIDE},
    )
