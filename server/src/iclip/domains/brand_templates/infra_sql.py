"""品牌资源表与片头片尾的 Postgres 仓储。时间统一用数据库时钟；外部输入一律走绑定参数。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Final

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    Table,
    Text,
    Uuid,
    text,
)
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.brand_templates.models import BrandTemplate, Position, ProbedVideo

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

brand_templates_table = Table(
    "brand_templates",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("kind", Text, nullable=False),
    # 未指定所属品牌时为空，不从名称或地址推断。
    Column("brand", Text, nullable=True),
    Column("name", Text, nullable=False),
    # 资源文件地址；以下媒体参数在不适用时为空。
    Column("url", Text, nullable=False),
    Column("width", Integer, nullable=True),
    Column("height", Integer, nullable=True),
    Column("duration_ms", Integer, nullable=True),
    Column("has_audio", Boolean, nullable=True),
    Column(
        "created_by",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", name="fk_brand_templates_created_by"),
        nullable=False,
    ),
    # 不关联外键，与生成记录的 api_key_id 同一做法。
    Column("api_key_id", Uuid, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    # 为空表示在用；停用不删，已有整片的请求里记着快照。
    Column("disabled_at", DateTime(timezone=True), nullable=True),
    CheckConstraint("kind ~ '[^[:space:]]'", name="ck_brand_templates_kind"),
    CheckConstraint("brand IS NULL OR brand ~ '[^[:space:]]'", name="ck_brand_templates_brand"),
    CheckConstraint("btrim(name) <> ''", name="ck_brand_templates_name"),
    CheckConstraint(
        "(width IS NULL OR width > 0) AND (height IS NULL OR height > 0)",
        name="ck_brand_templates_size",
    ),
    CheckConstraint("duration_ms IS NULL OR duration_ms > 0", name="ck_brand_templates_duration"),
)

_ROW: Final = """
SELECT id, kind AS position, name, url, width, height, duration_ms, has_audio, created_by,
       created_at, disabled_at
FROM iclip.brand_templates"""

_BY_ID: Final = text(f"{_ROW}\nWHERE id = :id AND kind IN ('intro', 'outro')")

_LIST: Final = text(f"""{_ROW}
WHERE kind IN ('intro', 'outro')
  AND (CAST(:position AS text) IS NULL OR kind = CAST(:position AS text))
  AND (CAST(:include_disabled AS boolean) OR disabled_at IS NULL)
ORDER BY created_at DESC, id DESC""")

_RETURNING: Final = """
RETURNING id, kind AS position, name, url, width, height, duration_ms, has_audio, created_by,
          created_at, disabled_at"""

_INSERT: Final = text(f"""
INSERT INTO iclip.brand_templates
    (id, kind, name, url, width, height, duration_ms, has_audio, created_by, api_key_id)
VALUES (:id, :position, :name, :url, :width, :height, :duration_ms, :has_audio,
        :created_by, :api_key_id){_RETURNING}""")

# 停用时已停用的保留原来的停用时刻；不给的那一项不动。
_UPDATE: Final = text(f"""
UPDATE iclip.brand_templates
SET name = coalesce(CAST(:name AS text), name),
    disabled_at = CASE
        WHEN CAST(:disabled AS boolean) IS NULL THEN disabled_at
        WHEN CAST(:disabled AS boolean) THEN coalesce(disabled_at, now())
        ELSE NULL
    END
WHERE id = :id AND kind IN ('intro', 'outro'){_RETURNING}""")


def _row_of(row: RowMapping) -> BrandTemplate:
    return BrandTemplate(
        id=row["id"],
        position=row["position"],
        name=row["name"],
        url=row["url"],
        width=row["width"],
        height=row["height"],
        duration_ms=row["duration_ms"],
        has_audio=row["has_audio"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        disabled_at=row["disabled_at"],
    )


class SqlBrandTemplateStore:
    """片头片尾视频的存取；表中的其他资源不进入视频模板接口。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(
        self,
        *,
        position: Position,
        name: str,
        url: str,
        video: ProbedVideo,
        created_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> BrandTemplate:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        _INSERT,
                        {
                            "id": uuid.uuid4(),
                            "position": position,
                            "name": name,
                            "url": url,
                            "width": video.width,
                            "height": video.height,
                            "duration_ms": video.duration_ms,
                            "has_audio": video.has_audio,
                            "created_by": created_by,
                            "api_key_id": api_key_id,
                        },
                    )
                )
                .mappings()
                .one()
            )
        return _row_of(row)

    async def get(self, template_id: uuid.UUID) -> BrandTemplate | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_BY_ID, {"id": template_id})).mappings().first()
        return None if row is None else _row_of(row)

    async def list(
        self, *, position: Position | None, include_disabled: bool
    ) -> Sequence[BrandTemplate]:
        async with self._engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        _LIST, {"position": position, "include_disabled": include_disabled}
                    )
                )
                .mappings()
                .all()
            )
        return [_row_of(row) for row in rows]

    async def update(
        self, template_id: uuid.UUID, *, name: str | None, disabled: bool | None
    ) -> BrandTemplate | None:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        _UPDATE, {"id": template_id, "name": name, "disabled": disabled}
                    )
                )
                .mappings()
                .first()
            )
        return None if row is None else _row_of(row)


__all__ = ["SqlBrandTemplateStore", "brand_templates_table", "metadata_obj"]
