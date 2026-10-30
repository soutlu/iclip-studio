"""运行时服务的鉴权落在真实的库上：没有密钥或密钥不对 401，没有管理权限的应用 403，都不写库；
有管理权限的应用写库时，作者记的是 ``X-End-User``。"""

from __future__ import annotations

import uuid

import httpx

from tests.helpers.runtime_service import ADMIN_KEY, READER_KEY


async def test_auth_failures_never_reach_the_database(
    anonymous: httpx.AsyncClient, admin: httpx.AsyncClient, actor: uuid.UUID
) -> None:
    body = {"id": "director", "name": "导演"}
    end_user = {"X-End-User": str(actor)}

    missing = await anonymous.post("/v1/admin/agents", json=body, headers=end_user)
    wrong = await anonymous.post(
        "/v1/admin/agents",
        json=body,
        headers={**end_user, "Authorization": f"Bearer {ADMIN_KEY[:-1]}x"},
    )
    reader = await anonymous.post(
        "/v1/admin/agents",
        json=body,
        headers={**end_user, "Authorization": f"Bearer {READER_KEY}"},
    )

    assert (missing.status_code, wrong.status_code, reader.status_code) == (401, 401, 403)
    assert {"detail"} == set(missing.json()) == set(wrong.json()) == set(reader.json())
    assert (await admin.get("/agents")).json()["items"] == []


async def test_the_end_user_is_recorded_as_the_author(
    admin: httpx.AsyncClient, actor: uuid.UUID
) -> None:
    created = await admin.post("/agents", json={"id": "director", "name": "导演"})

    assert created.status_code == 201, created.text
    assert created.json()["createdBy"] == str(actor)
    assert created.json()["draft"]["updatedBy"] == str(actor)
