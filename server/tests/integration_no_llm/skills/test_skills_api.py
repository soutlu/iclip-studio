"""技能库端点：只有 ``agent:manage``（root）能用，editor 一律 403；带斜杠的路径原样往返，冲突 409，
校验失败 422，导出给 zip、导入用 multipart。"""

from __future__ import annotations

import io
import zipfile
from typing import Any

import httpx
from fastapi import FastAPI

from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db

SKILL_MD = "---\nname: pdf-tools\ndescription: 处理 PDF\n---\n\n# PDF 工具\n"


async def login_as_root(client: httpx.AsyncClient, pg_url: str) -> str:
    user_id = await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(pg_url, "root@example.com", ["root"])
    return user_id


def zip_upload(data: bytes) -> dict[str, tuple[str, bytes, str]]:
    return {"file": ("pdf-tools.zip", data, "application/zip")}


async def test_every_skills_operation_requires_exactly_agent_manage(app: FastAPI) -> None:
    operations = [
        (method, path, operation)
        for path, item in app.openapi()["paths"].items()
        if path == "/skills" or path.startswith("/skills/")
        for method, operation in item.items()
    ]

    assert operations
    for method, path, operation in operations:
        scopes = {
            tuple(scopes)
            for requirement in operation["security"]
            for scopes in requirement.values()
        }
        assert scopes == {("agent:manage",)}, (method, path)


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
