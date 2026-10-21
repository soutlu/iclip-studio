"""``GET /library-tags``：预置的五个维度按先后排、带 ``autoFill`` 与下级；每个标签的条数含带它下级的、
同一条只算一次，移除的参考视频不算。打标没配置时照样挂着。"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.auth import login_as_editor
from tests.helpers.references import plant_reference, plant_user
from tests.helpers.tagging import plant_entry, tag_id


def find(nodes: list[dict[str, Any]], *path: str) -> dict[str, Any]:
    node: dict[str, Any] = {"children": nodes}
    for name in path:
        (node,) = [one for one in node["children"] if one["name"] == name]
    return node


async def test_anonymous_is_401(client: httpx.AsyncClient) -> None:
    assert (await client.get("/library-tags")).status_code == 401


async def test_the_seeded_tree_comes_in_order_with_auto_fill(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_editor(client, migrated_pg)

    response = await client.get("/library-tags")

    assert response.status_code == 200, response.text
    dimensions = response.json()["dimensions"]
    assert [(one["name"], one["autoFill"]) for one in dimensions] == [
        ("品牌", None),
        ("平台&渠道", None),
        ("品类", "ai"),
        ("场景", "ai"),
        ("内容结构", "ai"),
    ]
    assert [one["name"] for one in find(dimensions, "平台&渠道")["children"]] == [
        "AMZ",
        "DTC",
        "TikTok",
        "INS",
        "ADS",
    ]
    assert len(find(dimensions, "品类")["children"]) == 56
    structure = find(dimensions, "内容结构")
    assert len(structure["children"]) == 7
    compare = find(dimensions, "内容结构", "开箱测评型", "对比测评")
    assert (compare["guide"], compare["autoFill"], compare["children"]) == (
        "Comparison Battle",
        None,
        [],
    )


async def test_counts_include_children_once_and_skip_removed_references(
    client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    await login_as_editor(client, migrated_pg)
    owner = await plant_user(engine, "maya")
    review = await tag_id(engine, "内容结构", "开箱测评型")
    compare = await tag_id(engine, "内容结构", "开箱测评型", "对比测评")
    unbox = await tag_id(engine, "内容结构", "开箱测评型", "标准开箱流程")
    both = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/1.mp4")
    await plant_entry(engine, both, tags=[review, compare, unbox])
    child = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/2.mp4")
    await plant_entry(engine, child, tags=[compare])
    removed = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/3.mp4")
    await plant_entry(engine, removed, tags=[compare])
    await mark_removed(engine, removed)

    dimensions = (await client.get("/library-tags")).json()["dimensions"]

    def counts(*path: str) -> dict[str, int]:
        return find(dimensions, *path)["counts"]

    assert counts("内容结构", "开箱测评型") == {"references": 2, "hitCases": 0}
    assert counts("内容结构", "开箱测评型", "对比测评") == {"references": 2, "hitCases": 0}
    assert counts("内容结构", "开箱测评型", "标准开箱流程") == {"references": 1, "hitCases": 0}
    assert counts("内容结构") == {"references": 2, "hitCases": 0}
    assert counts("品类") == {"references": 0, "hitCases": 0}


async def mark_removed(engine: AsyncEngine, reference_id: uuid.UUID) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.reference_videos SET deleted_at = now() WHERE id = :id"),
            {"id": reference_id},
        )
