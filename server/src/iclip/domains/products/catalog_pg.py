from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.products.models import StyleGrouping

_RESOLVE_GROUPING: Final = text("""
SELECT product_number, product_category_id, brand AS brand_code
FROM public.pdm_styles
WHERE product_number = ANY(:style_nos) AND is_active AND NOT is_source_deleted
""")


def _blank_to_none(value: str | None) -> str | None:
    return value.strip() or None if value else None


class PgStyleDirectory:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def resolve(self, style_nos: Sequence[str]) -> Mapping[str, StyleGrouping]:
        if not style_nos:
            return {}
        async with self._engine.connect() as conn:
            rows = (
                (await conn.execute(_RESOLVE_GROUPING, {"style_nos": list(style_nos)}))
                .mappings()
                .all()
            )
        found: dict[str, StyleGrouping] = {}
        for row in rows:
            brand_code = _blank_to_none(row["brand_code"])
            if row["product_category_id"] is None or brand_code is None:
                continue
            found[row["product_number"]] = StyleGrouping(
                category_id=row["product_category_id"], brand_code=brand_code
            )
        return found


__all__ = ["PgStyleDirectory"]
