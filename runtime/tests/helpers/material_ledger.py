"""素材台账内存替身，按 (namespace, url) 精确匹配。

重复登记保留首条记录，与数据库 ON CONFLICT DO NOTHING 的语义一致。
"""

from __future__ import annotations

from collections.abc import Sequence

from agent_runtime.material_ledger.store import Material


class FakeMaterialLedger:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], Material] = {}

    async def record(self, namespace: str, materials: Sequence[Material]) -> None:
        for material in materials:
            self.rows.setdefault((namespace, material.url), material)

    async def lookup(self, namespace: str, url: str) -> Material | None:
        return self.rows.get((namespace, url))

    async def lookup_many(self, namespace: str, urls: Sequence[str]) -> dict[str, Material]:
        return {url: self.rows[namespace, url] for url in urls if (namespace, url) in self.rows}

    async def list_all(self, namespace: str) -> tuple[Material, ...]:
        return tuple(material for (space, _), material in self.rows.items() if space == namespace)

    def urls(self, namespace: str) -> set[str]:

        return {url for space, url in self.rows if space == namespace}


__all__ = ["FakeMaterialLedger"]
