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

from iclip.domains.brand_templates.models import BrandTemplate, ProbedVideo

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

brand_templates_table = Table(
    "brand_templates",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("kind", Text, nullable=False),
    Column("brand", Text, nullable=True),
    Column("name", Text, nullable=False),
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
    Column("api_key_id", Uuid, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
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
SELECT id, kind, brand, name, url, width, height, duration_ms, has_audio, created_by,
       created_at, disabled_at
FROM iclip.brand_templates"""

_BY_ID: Final = text(f"{_ROW}\nWHERE id = :id")

_LIST: Final = text(f"""{_ROW}
WHERE (CAST(:kind AS text) IS NULL OR kind = CAST(:kind AS text))
  AND (CAST(:brand AS text) IS NULL OR brand = CAST(:brand AS text))
  AND (CAST(:include_disabled AS boolean) OR disabled_at IS NULL)
ORDER BY created_at DESC, id DESC""")

_RETURNING: Final = """
RETURNING id, kind, brand, name, url, width, height, duration_ms, has_audio, created_by,
          created_at, disabled_at"""

_INSERT: Final = text(f"""
INSERT INTO iclip.brand_templates
    (id, kind, brand, name, url, width, height, duration_ms, has_audio, created_by, api_key_id)
VALUES (:id, :kind, :brand, :name, :url, :width, :height, :duration_ms, :has_audio,
        :created_by, :api_key_id) ON CONFLICT (id) DO NOTHING {_RETURNING}""")

_UPDATE: Final = text(f"""
UPDATE iclip.brand_templates
SET name = coalesce(CAST(:name AS text), name),
    brand = CASE WHEN :update_brand THEN CAST(:brand AS text) ELSE brand END,
    disabled_at = CASE
        WHEN CAST(:disabled AS boolean) IS NULL THEN disabled_at
        WHEN CAST(:disabled AS boolean) THEN coalesce(disabled_at, now())
        ELSE NULL
    END
WHERE id = :id{_RETURNING}""")


def _row_of(row: RowMapping) -> BrandTemplate:
    return BrandTemplate(
        id=row["id"],
        kind=row["kind"],
        brand=row["brand"],
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
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create(
        self,
        *,
        resource_id: uuid.UUID,
        kind: str,
        brand: str | None,
        name: str,
        url: str,
        video: ProbedVideo | None,
        created_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> BrandTemplate:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        _INSERT,
                        {
                            "id": resource_id,
                            "kind": kind,
                            "brand": brand,
                            "name": name,
                            "url": url,
                            "width": None if video is None else video.width,
                            "height": None if video is None else video.height,
                            "duration_ms": None if video is None else video.duration_ms,
                            "has_audio": None if video is None else video.has_audio,
                            "created_by": created_by,
                            "api_key_id": api_key_id,
                        },
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                row = (await conn.execute(_BY_ID, {"id": resource_id})).mappings().one()
        return _row_of(row)

    async def get(self, template_id: uuid.UUID) -> BrandTemplate | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_BY_ID, {"id": template_id})).mappings().first()
        return None if row is None else _row_of(row)

    async def list(
        self, *, kind: str | None, brand: str | None, include_disabled: bool
    ) -> Sequence[BrandTemplate]:
        async with self._engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        _LIST, {"kind": kind, "brand": brand, "include_disabled": include_disabled}
                    )
                )
                .mappings()
                .all()
            )
        return [_row_of(row) for row in rows]

    async def update(
        self,
        template_id: uuid.UUID,
        *,
        name: str | None,
        disabled: bool | None,
        brand: str | None = None,
        update_brand: bool = False,
    ) -> BrandTemplate | None:
        async with self._engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        _UPDATE,
                        {
                            "id": template_id,
                            "name": name,
                            "disabled": disabled,
                            "brand": brand,
                            "update_brand": update_brand,
                        },
                    )
                )
                .mappings()
                .first()
            )
        return None if row is None else _row_of(row)


__all__ = ["SqlBrandTemplateStore", "brand_templates_table", "metadata_obj"]
