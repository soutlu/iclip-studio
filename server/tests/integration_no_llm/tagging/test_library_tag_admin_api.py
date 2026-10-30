"""标签管理：``POST /library-tags``、``PATCH /library-tags/{id}``、``DELETE /library-tags/{id}``。

只有 ``library_tags:manage`` 能改；名称、层级、重名、AI 打标与取值上限不合格都是 422，同上级撞唯一约束也是；
``position`` 把同级重新编成 0..n-1；删掉的标签连同下级从条目上去掉，条数跟着变。

预置的树各用例共用：这里只在自己加的「测试」维度里动，用完删掉。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from agent_runtime.errors import ValidationFailed
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.tagging.infra_sql import SqlTagStore
from iclip.domains.tagging.models import AI_VALUE_LIMIT
from iclip.domains.tagging.schemas import LibraryTagCreateIn
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.references import plant_reference, plant_user
from tests.helpers.tagging import plant_entry, tag_id, tagging_service

PREFIX = "测试"


@pytest.fixture
async def scratch(engine: AsyncEngine) -> AsyncGenerator[None]:
    """用例结束时删掉名字以「测试」开头的维度，连同下级与条目上的这些标签。"""

    yield
    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM iclip.library_tags WHERE parent_id IS NULL AND name LIKE :prefix"),
            {"prefix": f"{PREFIX}%"},
        )


async def login_as_governor(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(pg_url, "root@example.com", ["root"])


async def create(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    response = await client.post("/library-tags", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def dimension(client: httpx.AsyncClient, name: str) -> dict[str, Any]:
    (found,) = [
        one
        for one in (await client.get("/library-tags")).json()["dimensions"]
        if one["name"] == name
    ]
    return found


async def plant_values(engine: AsyncEngine, parent: str, count: int) -> None:
    """直接往表里塞 ``count`` 个取值，造 AI 取值上限的场面。"""

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.library_tags (id, parent_id, name, position)"
                " SELECT gen_random_uuid(), CAST(:parent AS uuid), '塞' || g, g"
                " FROM generate_series(1, :count) AS g"
            ),
            {"parent": parent, "count": count},
        )


async def ai_value_count(client: httpx.AsyncClient) -> int:
    def size(node: dict[str, Any]) -> int:
        return sum(1 + size(child) for child in node["children"])

    dimensions = (await client.get("/library-tags")).json()["dimensions"]
    return sum(size(one) for one in dimensions if one["autoFill"] == "ai")


@pytest.mark.usefixtures("scratch")
async def test_direct_tag_management_grant_allows_tree_changes_without_user_management(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    some = str(await tag_id(engine, "场景", "居家/日常放松"))
    calls = (
        ("POST", "/library-tags", {"name": f"{PREFIX}维度"}),
        ("PATCH", f"/library-tags/{some}", {"name": "居家"}),
        ("DELETE", f"/library-tags/{some}", None),
    )
    for method, url, body in calls:
        assert (await client.request(method, url, json=body)).status_code == 401

    user_id = await login_as_editor(client, migrated_pg)

    for method, url, body in calls:
        assert (await client.request(method, url, json=body)).status_code == 403
    assert await tag_id(engine, "场景", "居家/日常放松") == uuid.UUID(some)

    async with make_client(app) as root:
        await login_as_governor(root, migrated_pg)
        granted = await root.patch(
            f"/users/{user_id}", json={"directPermissions": ["library_tags:manage"]}
        )
        assert granted.status_code == 200, granted.text
        assert granted.json()["user"]["roles"] == ["editor"]
        assert granted.json()["user"]["directPermissions"] == ["library_tags:manage"]

    made = await create(client, name=f"{PREFIX}授权")
    renamed = await client.patch(f"/library-tags/{made['id']}", json={"name": f"{PREFIX}改名"})
    assert renamed.status_code == 200, renamed.text
    assert (await dimension(client, f"{PREFIX}改名"))["id"] == made["id"]
    assert (await client.delete(f"/library-tags/{made['id']}")).status_code == 204
    assert made["id"] not in {
        one["id"] for one in (await client.get("/library-tags")).json()["dimensions"]
    }
    assert (await client.get("/users")).status_code == 403
    assert (
        await client.patch(f"/users/{user_id}", json={"directPermissions": ["users:manage"]})
    ).status_code == 403


@pytest.mark.usefixtures("scratch")
async def test_governor_adds_three_levels_of_values_in_order(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_governor(client, migrated_pg)

    made = await create(client, name=f"  {PREFIX}结构 ", autoFill="ai", guide=" 选最贴切的 ")
    assert {key: made[key] for key in ("name", "autoFill", "guide", "counts", "children")} == {
        "name": f"{PREFIX}结构",
        "autoFill": "ai",
        "guide": "选最贴切的",
        "counts": {"references": 0, "hitCases": 0},
        "children": [],
    }
    first = await create(client, parentId=made["id"], name="大类甲")
    second = await create(client, parentId=made["id"], name="大类乙", guide="")
    sub = await create(client, parentId=first["id"], name="小类")
    await create(client, parentId=sub["id"], name="具体场景乙")
    await create(client, parentId=sub["id"], name="具体场景甲", position=0)
    assert (first["autoFill"], second["guide"], sub["position"]) == (None, None, 0)
    front = await create(client, parentId=made["id"], name="大类丙", position=0)
    assert front["position"] == 0

    tree = await dimension(client, f"{PREFIX}结构")
    assert [(one["name"], one["position"]) for one in tree["children"]] == [
        ("大类丙", 0),
        ("大类甲", 1),
        ("大类乙", 2),
    ]
    assert [one["name"] for one in tree["children"][1]["children"]] == ["小类"]
    assert [
        (one["name"], one["position"], one["guide"])
        for one in tree["children"][1]["children"][0]["children"]
    ] == [("具体场景甲", 0, None), ("具体场景乙", 1, None)]
    assert tree["position"] == len((await client.get("/library-tags")).json()["dimensions"]) - 1


@pytest.mark.usefixtures("scratch")
async def test_deep_values_can_be_assigned_filtered_counted_and_deleted(
    client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    """末级可人工补标；各级筛选包含后代，计数去重，删中间节点会级联清理末级关联。"""

    await login_as_governor(client, migrated_pg)
    made = await create(client, name=f"{PREFIX}场景", autoFill="ai")
    city = await create(client, parentId=made["id"], name="城市")
    commute = await create(client, parentId=city["id"], name="通勤")
    walk = await create(client, parentId=commute["id"], name="步行")
    owner = await plant_user(engine, "maya")
    first = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/1.mp4")
    second = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/2.mp4")
    for reference_id, tags in (
        (first, [city["id"], commute["id"], walk["id"]]),
        (second, [walk["id"]]),
    ):
        assigned = await client.put(f"/references/{reference_id}/tags", json={"tagIds": tags})
        assert assigned.status_code == 200, assigned.text
        assert set(assigned.json()["tagIds"]) == set(tags)

    tree = await dimension(client, f"{PREFIX}场景")
    for level in (tree, tree["children"][0], tree["children"][0]["children"][0]):
        assert level["counts"] == {"references": 2, "hitCases": 0}
    assert tree["children"][0]["children"][0]["children"][0]["counts"]["references"] == 2
    for tag in (made, city, commute, walk):
        listed = await client.get("/references", params={"tags": tag["id"]})
        assert listed.status_code == 200, listed.text
        assert {item["id"] for item in listed.json()["items"]} == {str(first), str(second)}
        assert listed.json()["total"] == 2

    assert (await client.delete(f"/library-tags/{commute['id']}")).status_code == 204
    for reference_id, expected in ((first, [city["id"]]), (second, [])):
        response = await client.get(f"/references/{reference_id}")
        assert response.status_code == 200, response.text
        assert response.json()["tagIds"] == expected


@pytest.mark.usefixtures("scratch")
async def test_governor_renames_and_switches_fields_and_moves_within_siblings(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_governor(client, migrated_pg)
    made = await create(client, name=f"{PREFIX}渠道")
    a, b, c, d = [await create(client, parentId=made["id"], name=name) for name in "甲乙丙丁"]

    renamed = await client.patch(
        f"/library-tags/{b['id']}", json={"name": " 乙二 ", "guide": "说明"}
    )
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["guide"]) == ("乙二", "说明")
    cleared = (await client.patch(f"/library-tags/{b['id']}", json={"guide": None})).json()
    assert (cleared["name"], cleared["guide"]) == ("乙二", None)

    switched = await client.patch(f"/library-tags/{made['id']}", json={"autoFill": "ai"})
    assert switched.json()["autoFill"] == "ai"
    assert [one["name"] for one in switched.json()["children"]] == ["甲", "乙二", "丙", "丁"]
    back = await client.patch(f"/library-tags/{made['id']}", json={"autoFill": None})
    assert back.json()["autoFill"] is None

    async def order() -> list[tuple[str, int]]:
        children = (await dimension(client, f"{PREFIX}渠道"))["children"]
        return [(one["name"], one["position"]) for one in children]

    moved = await client.patch(f"/library-tags/{c['id']}", json={"position": 0})
    assert moved.json()["position"] == 0
    assert await order() == [("丙", 0), ("甲", 1), ("乙二", 2), ("丁", 3)]
    await client.patch(f"/library-tags/{a['id']}", json={"position": 99})
    assert await order() == [("丙", 0), ("乙二", 1), ("丁", 2), ("甲", 3)]
    await client.patch(f"/library-tags/{d['id']}", json={"position": -1})
    assert await order() == [("丁", 0), ("丙", 1), ("乙二", 2), ("甲", 3)]


@pytest.mark.usefixtures("scratch")
async def test_invalid_changes_are_422_with_a_readable_reason(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_governor(client, migrated_pg)
    made = await create(client, name=f"{PREFIX}结构")
    value = await create(client, parentId=made["id"], name="大类")
    sub = await create(client, parentId=value["id"], name="小类")
    last = await create(client, parentId=sub["id"], name="具体场景")

    cases: list[tuple[str, str, dict[str, Any], str]] = [
        ("POST", "", {"name": "   "}, "请填写名称"),
        ("POST", "", {"name": "字" * 51}, "名称最多 50 个字"),
        ("POST", "", {"name": f"{PREFIX}长", "guide": "字" * 1001}, "判断说明最多 1000 个字"),
        ("POST", "", {"name": "x", "parentId": str(uuid.uuid4())}, "上级标签不存在"),
        ("POST", "", {"name": "再一层", "parentId": last["id"]}, "标签最多三级"),
        ("POST", "", {"name": "品类"}, "已有名为「品类」的维度"),
        ("POST", "", {"name": "小类", "parentId": made["id"]}, f"「{PREFIX}结构」中已有「小类」"),
        ("POST", "", {"name": "大类", "parentId": value["id"]}, f"「{PREFIX}结构」中已有「大类」"),
        ("POST", "", {"name": "新", "parentId": made["id"], "autoFill": "ai"}, "只有维度可设"),
        ("PATCH", f"/{value['id']}", {"autoFill": "ai"}, "只有维度可设为 AI 打标"),
        ("PATCH", f"/{sub['id']}", {"name": "大类"}, f"「{PREFIX}结构」中已有「大类」"),
        ("PATCH", f"/{made['id']}", {"name": "内容结构"}, "已有名为「内容结构」的维度"),
        ("PATCH", f"/{made['id']}", {"name": ""}, "请填写名称"),
    ]
    for method, path, body, reason in cases:
        response = await client.request(method, f"/library-tags{path}", json=body)
        assert response.status_code == 422, (body, response.text)
        assert reason in response.json()["detail"], (body, response.text)

    moved = await client.patch(f"/library-tags/{sub['id']}", json={"parentId": made["id"]})
    assert moved.status_code == 422
    missing = uuid.uuid4()
    assert (await client.patch(f"/library-tags/{missing}", json={"name": "x"})).status_code == 404
    assert (await client.delete(f"/library-tags/{missing}")).status_code == 404


@pytest.mark.usefixtures("scratch")
async def test_ai_values_stop_at_the_limit(
    client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    await login_as_governor(client, migrated_pg)
    ai = await create(client, name=f"{PREFIX}AI", autoFill="ai")
    await plant_values(engine, ai["id"], AI_VALUE_LIMIT - await ai_value_count(client))
    assert await ai_value_count(client) == AI_VALUE_LIMIT

    full = await client.post("/library-tags", json={"parentId": ai["id"], "name": "多一个"})
    assert full.status_code == 422
    assert f"最多 {AI_VALUE_LIMIT} 个" in full.json()["detail"]
    manual = await create(client, name=f"{PREFIX}人工")
    await create(client, parentId=manual["id"], name="人工维度不受限")

    switched = await client.patch(f"/library-tags/{manual['id']}", json={"autoFill": "ai"})
    assert switched.status_code == 422
    assert f"超过上限 {AI_VALUE_LIMIT} 个" in switched.json()["detail"]

    assert (await client.delete(f"/library-tags/{ai['id']}")).status_code == 204
    switched = await client.patch(f"/library-tags/{manual['id']}", json={"autoFill": "ai"})
    assert switched.status_code == 200, switched.text


@pytest.mark.usefixtures("scratch")
async def test_deleting_takes_the_tag_and_its_children_off_entries(
    client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    await login_as_governor(client, migrated_pg)
    made = await create(client, name=f"{PREFIX}结构")
    value = await create(client, parentId=made["id"], name="大类")
    sub = await create(client, parentId=value["id"], name="小类")
    other = await create(client, parentId=made["id"], name="另一类")
    kept = await tag_id(engine, "场景", "居家/日常放松")
    owner = await plant_user(engine, "maya")
    one = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/1.mp4")
    entry = await plant_entry(engine, one, tags=[uuid.UUID(sub["id"]), kept])
    two = await plant_reference(engine, owner=owner, video_url="https://cdn.example.test/2.mp4")
    await plant_entry(engine, two, tags=[uuid.UUID(other["id"])])
    assert (await dimension(client, f"{PREFIX}结构"))["counts"]["references"] == 2

    assert (await client.delete(f"/library-tags/{value['id']}")).status_code == 204

    tree = await dimension(client, f"{PREFIX}结构")
    assert [one["name"] for one in tree["children"]] == ["另一类"]
    assert tree["counts"]["references"] == 1
    assert await entry_tags(engine, entry) == {kept}

    assert (await client.delete(f"/library-tags/{made['id']}")).status_code == 204
    names = [one["name"] for one in (await client.get("/library-tags")).json()["dimensions"]]
    assert f"{PREFIX}结构" not in names
    async with engine.connect() as conn:
        left = (
            await conn.execute(
                text("SELECT count(*) FROM iclip.library_entry_tags WHERE tag_id = :id"),
                {"id": other["id"]},
            )
        ).scalar_one()
    assert left == 0


async def entry_tags(engine: AsyncEngine, entry_id: uuid.UUID) -> set[uuid.UUID]:
    async with engine.connect() as conn:
        return set(
            (
                await conn.execute(
                    text("SELECT tag_id FROM iclip.library_entry_tags WHERE entry_id = :id"),
                    {"id": entry_id},
                )
            ).scalars()
        )


@pytest.mark.usefixtures("scratch")
async def test_a_same_parent_name_clash_at_the_table_is_422_not_500(
    client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    """服务层查过重名，唯一约束只在有人绕过写锁时才撞上；撞上了同样是给人看的 422。"""

    await login_as_governor(client, migrated_pg)
    made = await create(client, name=f"{PREFIX}渠道")
    await create(client, parentId=made["id"], name="AMZ")

    with pytest.raises(ValidationFailed, match="同一上级下已有同名标签"):
        async with SqlTagStore(engine).edit() as writer:
            await writer.insert(
                uuid.uuid4(),
                parent_id=uuid.UUID(made["id"]),
                name="AMZ",
                guide=None,
                auto_fill=None,
                position=1,
            )
    assert [one["name"] for one in (await dimension(client, f"{PREFIX}渠道"))["children"]] == [
        "AMZ"
    ]


@pytest.mark.usefixtures("scratch")
async def test_a_concurrent_add_waits_and_then_sees_the_other_name(
    client: httpx.AsyncClient, migrated_pg: str, engine: AsyncEngine
) -> None:
    """同一维度里两处同时加同名：表上的唯一约束只管同一上级，靠写锁让后到的等先到的提交再读树。"""

    await login_as_governor(client, migrated_pg)
    made = await create(client, name=f"{PREFIX}结构")
    value = await create(client, parentId=made["id"], name="大类")
    service = tagging_service(engine)

    async with SqlTagStore(engine).edit() as first:
        second = asyncio.create_task(
            service.create(LibraryTagCreateIn(parent_id=uuid.UUID(value["id"]), name="撞名"))
        )
        # 让后到的那一个先跑到等锁（没有锁就是已经读完树）。
        await asyncio.sleep(0.3)
        assert not second.done()
        await first.insert(
            uuid.uuid4(),
            parent_id=uuid.UUID(made["id"]),
            name="撞名",
            guide=None,
            auto_fill=None,
            position=1,
        )

    with pytest.raises(ValidationFailed, match=f"「{PREFIX}结构」中已有「撞名」"):
        await second
