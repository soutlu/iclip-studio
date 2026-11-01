"""技能库端点：只有 ``agent:manage``（root）能用，editor 一律 403；带斜杠的路径原样往返，冲突 409，
校验失败 422，导出给 zip、导入用 multipart。"""

from __future__ import annotations

import io
import uuid
import zipfile
from typing import Any

import httpx
from fastapi import FastAPI

from tests.helpers.auth import (
    login_as_editor,
    register_and_login,
    set_display_name_in_db,
    set_roles_in_db,
)
from tests.helpers.runtime_backed import runtime_admin

SKILL_MD = "---\nname: pdf-tools\ndescription: 处理 PDF\n---\n\n# PDF 工具\n"


async def login_as_root(client: httpx.AsyncClient, pg_url: str) -> str:
    user_id = await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(pg_url, "root@example.com", ["root"])
    return user_id


def zip_upload(data: bytes) -> dict[str, tuple[str, bytes, str]]:
    return {"file": ("pdf-tools.zip", data, "application/zip")}


async def test_editor_is_forbidden_everywhere(client: httpx.AsyncClient, migrated_pg: str) -> None:
    await login_as_editor(client, migrated_pg)
    some = "00000000-0000-0000-0000-000000000001"

    calls: tuple[tuple[str, str, dict[str, Any]], ...] = (
        ("GET", "/skills", {}),
        ("POST", "/skills", {"json": {"name": "a", "displayName": "A", "description": "d"}}),
        ("GET", f"/skills/{some}", {}),
        (
            "PUT",
            f"/skills/{some}/draft/files/references/a.md",
            {"json": {"content": "x", "baseHash": None}},
        ),
        (
            "POST",
            f"/skills/{some}/draft/files/rename",
            {"json": {"from": "references/a.md", "to": "references/b.md", "baseHash": "x"}},
        ),
        ("POST", f"/skills/{some}/versions", {"json": {}}),
        ("GET", f"/skills/{some}/export", {}),
        ("POST", "/skills/import", {"params": {"dryRun": "true"}, "files": zip_upload(b"x")}),
    )
    for method, url, kwargs in calls:
        assert (await client.request(method, url, **kwargs)).status_code == 403, (method, url)


async def test_root_manages_a_skill_end_to_end(client: httpx.AsyncClient, migrated_pg: str) -> None:
    author = await login_as_root(client, migrated_pg)

    created = await client.post(
        "/skills", json={"name": "pdf-tools", "displayName": "PDF 工具", "description": "处理 PDF"}
    )
    assert created.status_code == 201, created.text
    skill = created.json()
    assert (skill["name"], skill["status"], skill["latestVersion"]) == ("pdf-tools", "active", None)
    assert skill["createdBy"] == author
    assert skill["hasUnpublishedChanges"] is True
    assert [one["path"] for one in skill["draftFiles"]] == ["SKILL.md"]
    base = f"/skills/{skill['id']}"

    duplicate = await client.post(
        "/skills", json={"name": "pdf-tools", "displayName": "又一个", "description": "x"}
    )
    assert duplicate.status_code == 409
    bad_name = await client.post(
        "/skills", json={"name": "PDF_Tools", "displayName": "x", "description": "x"}
    )
    assert bad_name.status_code == 422

    nested = f"{base}/draft/files/references/sub/指南.md"
    written = await client.put(nested, json={"content": "第一版", "baseHash": None})
    assert written.status_code == 200, written.text
    assert (written.json()["path"], written.json()["content"]) == (
        "references/sub/指南.md",
        "第一版",
    )
    read = await client.get(nested)
    assert (read.json()["content"], read.json()["hash"]) == ("第一版", written.json()["hash"])
    stale = await client.put(nested, json={"content": "x", "baseHash": "0" * 64})
    assert stale.status_code == 409
    outside = await client.put(
        f"{base}/draft/files/scripts/run.py", json={"content": "x", "baseHash": None}
    )
    assert outside.status_code == 422
    assert "scripts/run.py" in outside.json()["detail"]

    published = await client.post(f"{base}/versions", json={"note": "第一版"})
    assert published.status_code == 201, published.text
    version = published.json()
    assert (version["version"], version["note"], version["createdBy"]) == (1, "第一版", author)
    unchanged = await client.post(f"{base}/versions", json={})
    assert unchanged.status_code == 422

    versions = (await client.get(f"{base}/versions")).json()["items"]
    assert [one["id"] for one in versions] == [version["id"]]
    detail = (await client.get(f"{base}/versions/{version['id']}")).json()
    assert [one["path"] for one in detail["files"]] == ["SKILL.md", "references/sub/指南.md"]
    version_file = await client.get(f"{base}/versions/{version['id']}/files/references/sub/指南.md")
    assert version_file.json()["content"] == "第一版"

    exported = await client.get(f"{base}/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/zip"
    assert "pdf-tools-v1.zip" in exported.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert sorted(archive.namelist()) == [
            "pdf-tools/SKILL.md",
            "pdf-tools/references/sub/指南.md",
        ]
    checked = await client.post(
        "/skills/import", params={"dryRun": "true"}, files=zip_upload(exported.content)
    )
    assert checked.status_code == 200, checked.text
    assert (checked.json()["action"], checked.json()["skillId"]) == ("overwrite", skill["id"])
    assert checked.json()["files"] == detail["files"]

    current = (await client.get(nested)).json()["hash"]
    deleted = await client.delete(nested, params={"baseHash": current})
    assert deleted.status_code == 204
    assert (await client.get(nested)).status_code == 404
    skill_md_hash = (await client.get(f"{base}/draft/files/SKILL.md")).json()["hash"]
    assert (
        await client.delete(f"{base}/draft/files/SKILL.md", params={"baseHash": skill_md_hash})
    ).status_code == 422

    restored = await client.post(f"{base}/versions/{version['id']}/restore")
    assert restored.status_code == 200
    assert restored.json()["hasUnpublishedChanges"] is False
    assert (await client.get(nested)).json()["content"] == "第一版"

    renamed = await client.patch(base, json={"displayName": "  新的  名字 "})
    assert renamed.json()["displayName"] == "新的 名字"
    archived = await client.post(f"{base}/archive")
    assert archived.json()["status"] == "archived"
    assert (await client.get("/skills")).json()["items"][0]["status"] == "archived"
    assert (await client.post(f"{base}/unarchive")).json()["status"] == "active"


async def test_import_creates_a_draft_only_skill(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_root(client, migrated_pg)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("SKILL.md", SKILL_MD)
        archive.writestr("references/a.md", "a")

    imported = await client.post(
        "/skills/import", params={"dryRun": "false"}, files=zip_upload(buffer.getvalue())
    )

    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert (body["action"], body["name"], body["displayName"], body["problems"]) == (
        "create",
        "pdf-tools",
        "PDF 工具",
        [],
    )
    skill = (await client.get(f"/skills/{body['skillId']}")).json()
    assert [one["path"] for one in skill["draftFiles"]] == ["SKILL.md", "references/a.md"]
    assert skill["latestVersionId"] is None
    assert (await client.get(f"/skills/{body['skillId']}/export")).status_code == 404

    broken = await client.post(
        "/skills/import", params={"dryRun": "false"}, files=zip_upload(b"not a zip")
    )
    assert broken.status_code == 422


async def test_renaming_a_draft_file_moves_it_in_one_step(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """内容与 hash 不变、旧路径没了；hash 对不上、新路径已有文件是 409，SKILL.md、范围外的新路径与原地
    改名是 422，原文件不在是 404。被拒的改名什么都不动。"""

    await login_as_root(client, migrated_pg)
    created = await client.post(
        "/skills", json={"name": "pdf-tools", "displayName": "PDF 工具", "description": "处理 PDF"}
    )
    base = f"/skills/{created.json()['id']}"
    files = f"{base}/draft/files"
    first = (
        await client.put(f"{files}/references/a.md", json={"content": "甲", "baseHash": None})
    ).json()
    await client.put(f"{files}/references/b.md", json={"content": "乙", "baseHash": None})
    skill_md = (await client.get(f"{files}/SKILL.md")).json()

    async def rename(source: str, target: str, base_hash: str) -> httpx.Response:
        return await client.post(
            f"{files}/rename", json={"from": source, "to": target, "baseHash": base_hash}
        )

    refusals = (
        (("references/a.md", "references/c.md", "0" * 64), 409),
        (("references/a.md", "references/b.md", first["hash"]), 409),
        (("SKILL.md", "references/SKILL.md", skill_md["hash"]), 422),
        (("references/a.md", "scripts/a.md", first["hash"]), 422),
        (("references/a.md", "references/a.md", first["hash"]), 422),
        (("references/ghost.md", "references/c.md", first["hash"]), 404),
    )
    for args, status in refusals:
        refused = await rename(*args)
        assert refused.status_code == status, (args, refused.text)
    unchanged = (await client.get(base)).json()["draftFiles"]
    assert [one["path"] for one in unchanged] == ["SKILL.md", "references/a.md", "references/b.md"]

    moved = await rename("references/a.md", "references/sub/c.md", first["hash"])

    assert moved.status_code == 200, moved.text
    assert (moved.json()["path"], moved.json()["content"], moved.json()["hash"]) == (
        "references/sub/c.md",
        "甲",
        first["hash"],
    )
    assert (await client.get(f"{files}/references/a.md")).status_code == 404
    after = (await client.get(base)).json()["draftFiles"]
    assert [one["path"] for one in after] == ["SKILL.md", "references/b.md", "references/sub/c.md"]


async def test_skill_answers_name_the_people_behind_the_ids(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """列表、详情、版本都带操作人的显示名；运行时记下的人在本系统里没有时为 null。"""

    author = await login_as_root(client, migrated_pg)
    await set_display_name_in_db(migrated_pg, "root@example.com", "管理员")
    created = await client.post(
        "/skills", json={"name": "pdf-tools", "displayName": "PDF 工具", "description": "处理 PDF"}
    )
    base = f"/skills/{created.json()['id']}"
    published = await client.post(f"{base}/versions", json={})
    version_id = published.json()["id"]
    stranger = str(uuid.uuid4())
    async with runtime_admin(app, end_user=stranger) as direct:
        ghost = await direct.post(
            "/skills", json={"name": "ghost-made", "displayName": "无主", "description": "x"}
        )
        assert ghost.status_code == 201, ghost.text

    assert (created.json()["createdBy"], created.json()["createdByName"]) == (author, "管理员")
    assert published.json()["createdByName"] == "管理员"
    listed = {one["name"]: one for one in (await client.get("/skills")).json()["items"]}
    assert (listed["pdf-tools"]["createdByName"], listed["ghost-made"]["createdBy"]) == (
        "管理员",
        stranger,
    )
    assert listed["ghost-made"]["createdByName"] is None
    versions = (await client.get(f"{base}/versions")).json()["items"]
    assert [one["createdByName"] for one in versions] == ["管理员"]
    version = (await client.get(f"{base}/versions/{version_id}")).json()
    assert version["createdByName"] == "管理员"
    assert (await client.get(f"/skills/{ghost.json()['id']}")).json()["createdByName"] is None
