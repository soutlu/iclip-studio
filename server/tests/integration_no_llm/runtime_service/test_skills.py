"""运行时服务的技能库管理接口：建、写草稿、发布、列版本、导出 zip、导入先检查，路径带斜杠原样往返。"""

from __future__ import annotations

import io
import uuid
import zipfile

import httpx


def zip_upload(data: bytes) -> dict[str, tuple[str, bytes, str]]:
    return {"file": ("pdf-tools.zip", data, "application/zip")}


async def test_admin_manages_a_skill_end_to_end(admin: httpx.AsyncClient, actor: uuid.UUID) -> None:
    created = await admin.post(
        "/skills", json={"name": "pdf-tools", "displayName": "PDF 工具", "description": "处理 PDF"}
    )
    assert created.status_code == 201, created.text
    skill = created.json()
    assert (skill["name"], skill["latestVersion"], skill["createdBy"]) == (
        "pdf-tools",
        None,
        str(actor),
    )
    base = f"/skills/{skill['id']}"
    assert (
        await admin.post(
            "/skills", json={"name": "pdf-tools", "displayName": "又一个", "description": "x"}
        )
    ).status_code == 409

    nested = f"{base}/draft/files/references/sub/指南.md"
    written = await admin.put(nested, json={"content": "第一版", "baseHash": None})
    assert written.status_code == 200, written.text
    assert (await admin.get(nested)).json()["content"] == "第一版"
    assert (await admin.put(nested, json={"content": "x", "baseHash": "0" * 64})).status_code == 409

    published = await admin.post(f"{base}/versions", json={"note": "第一版"})
    assert published.status_code == 201, published.text
    version = published.json()
    assert (version["version"], version["createdBy"]) == (1, str(actor))
    assert (await admin.post(f"{base}/versions", json={})).status_code == 422

    listed = (await admin.get("/skills")).json()["items"]
    assert [(one["name"], one["latestVersion"]) for one in listed] == [("pdf-tools", 1)]
    versions = (await admin.get(f"{base}/versions")).json()["items"]
    assert [one["id"] for one in versions] == [version["id"]]
    detail = (await admin.get(f"{base}/versions/{version['id']}")).json()
    assert [one["path"] for one in detail["files"]] == ["SKILL.md", "references/sub/指南.md"]

    exported = await admin.get(f"{base}/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/zip"
    assert "pdf-tools-v1.zip" in exported.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert sorted(archive.namelist()) == [
            "pdf-tools/SKILL.md",
            "pdf-tools/references/sub/指南.md",
        ]

    checked = await admin.post(
        "/skills/import", params={"dryRun": "true"}, files=zip_upload(exported.content)
    )
    assert checked.status_code == 200, checked.text
    assert (checked.json()["action"], checked.json()["skillId"]) == ("overwrite", skill["id"])
    assert checked.json()["files"] == detail["files"]

    archived = await admin.post(f"{base}/archive")
    assert archived.json()["status"] == "archived"
    assert (await admin.post(f"{base}/unarchive")).json()["status"] == "active"


async def test_a_real_import_creates_a_draft_only_skill(admin: httpx.AsyncClient) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("SKILL.md", "---\nname: pdf-tools\ndescription: 处理 PDF\n---\n\n# PDF\n")
        archive.writestr("references/a.md", "a")

    imported = await admin.post("/skills/import", files=zip_upload(buffer.getvalue()))

    assert imported.status_code == 200, imported.text
    assert (imported.json()["action"], imported.json()["problems"]) == ("create", [])
    skill = (await admin.get(f"/skills/{imported.json()['skillId']}")).json()
    assert [one["path"] for one in skill["draftFiles"]] == ["SKILL.md", "references/a.md"]
    assert skill["latestVersionId"] is None
    assert (await admin.post("/skills/import", files=zip_upload(b"not a zip"))).status_code == 422
