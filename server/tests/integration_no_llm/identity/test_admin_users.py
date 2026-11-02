"""用户管理面：分页信封、users:manage 门控、自我保护规则与授权上限。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tests.helpers.app import make_client
from tests.helpers.auth import register_and_login, set_roles_in_db


async def test_users_page_requires_manage_permission(
    client: httpx.AsyncClient,
) -> None:
    await register_and_login(client)
    assert (await client.get("/users")).status_code == 403


async def test_root_lists_users_with_page_envelope(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_roles_in_db(migrated_pg, "logan@example.com", ["root"])

    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "logan", "password": "password-123"})
        page = await root.get("/users", params={"page": 1, "pageSize": 10})
    assert page.status_code == 200
    payload = page.json()
    assert payload["total"] == 1
    assert payload["page"] == 1
    assert payload["pageSize"] == 10
    item = payload["items"][0]
    assert item["roles"] == ["root"]
    assert item["directPermissions"] == []
    assert item["isActive"] is True
    assert "createdAt" in item


async def test_root_updates_roles_grants_and_self_protection(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    root_id = await register_and_login(client)
    await set_roles_in_db(migrated_pg, "logan@example.com", ["root"])

    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "logan", "password": "password-123"})
        other = await root.post(
            "/auth/register",
            json={
                "email": "member@example.com",
                "password": "password-123",
                "username": "member",
            },
        )
        other_id = other.json()["id"]

        promoted = await root.patch(f"/users/{other_id}", json={"roles": ["editor"]})
        assert promoted.status_code == 200
        assert promoted.json()["user"]["roles"] == ["editor"]

        granted = await root.patch(
            f"/users/{other_id}", json={"directPermissions": ["api_keys:issue"]}
        )
        assert granted.status_code == 200
        user = granted.json()["user"]
        assert user["directPermissions"] == ["api_keys:issue"]
        assert "api_keys:issue" in user["permissions"]

        assert (
            await root.patch(f"/users/{root_id}", json={"roles": ["viewer"]})
        ).status_code == 400
        assert (
            await root.patch(f"/users/{root_id}", json={"directPermissions": ["agent:run"]})
        ).status_code == 400
        assert (await root.patch(f"/users/{root_id}", json={"isActive": False})).status_code == 400

        deactivated = await root.patch(f"/users/{other_id}", json={"isActive": False})
        assert deactivated.status_code == 200
        assert deactivated.json()["user"]["isActive"] is False

    async with make_client(app) as member:
        login = await member.post(
            "/auth/login", data={"username": "member", "password": "password-123"}
        )
        assert login.status_code == 400


async def test_granting_stays_within_the_managers_own_permissions(
    app: FastAPI, migrated_pg: str
) -> None:
    """admin 能管用户，但给出的权限不能超出自己的：改完后对方多出的、admin 没有的权限一律 403；
    对方原本就有的可以原样保留，收回与改别的字段照常。root 不受限。"""

    async with (
        make_client(app) as root,
        make_client(app) as admin,
        make_client(app) as member,
        make_client(app) as other_root,
    ):
        await register_and_login(root, username="rose", email="rose@example.com")
        await set_roles_in_db(migrated_pg, "rose@example.com", ["root"])
        await register_and_login(admin, username="ada", email="ada@example.com")
        await set_roles_in_db(migrated_pg, "ada@example.com", ["admin"])
        member_id = await register_and_login(member, username="mia", email="mia@example.com")
        other_root_id = await register_and_login(
            other_root, username="otto", email="otto@example.com"
        )

        made_root = await root.patch(f"/users/{other_root_id}", json={"roles": ["root"]})
        assert made_root.status_code == 200, made_root.text
        assert made_root.json()["user"]["roles"] == ["root"]

        listed = await admin.get("/users")
        assert listed.status_code == 200, listed.text

        to_root = await admin.patch(f"/users/{member_id}", json={"roles": ["root"]})
        assert to_root.status_code == 403
        assert to_root.json() == {"detail": "不能授予超出自己权限的角色或权限"}
        direct = await admin.patch(
            f"/users/{member_id}", json={"directPermissions": ["agent:manage"]}
        )
        assert direct.status_code == 403

        within = await admin.patch(f"/users/{member_id}", json={"roles": ["admin"]})
        assert within.status_code == 200, within.text
        assert within.json()["user"]["roles"] == ["admin"]
        assert within.json()["user"]["directPermissions"] == []

        kept = await admin.patch(f"/users/{other_root_id}", json={"roles": ["root"]})
        assert kept.status_code == 200, kept.text
        deactivated = await admin.patch(f"/users/{other_root_id}", json={"isActive": False})
        assert deactivated.status_code == 200, deactivated.text
        assert deactivated.json()["user"]["roles"] == ["root"]
        assert deactivated.json()["user"]["isActive"] is False
        demoted = await admin.patch(f"/users/{other_root_id}", json={"roles": ["editor"]})
        assert demoted.status_code == 200, demoted.text
        assert "agent:manage" not in demoted.json()["user"]["permissions"]


async def test_unknown_role_and_permission_rejected(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(client)
    await set_roles_in_db(migrated_pg, "logan@example.com", ["root"])
    async with make_client(app) as root:
        await root.post("/auth/login", data={"username": "logan", "password": "password-123"})
        other = await root.post(
            "/auth/register",
            json={"email": "x@example.com", "password": "password-123", "username": "x"},
        )
        other_id = other.json()["id"]
        assert (
            await root.patch(f"/users/{other_id}", json={"roles": ["superadmin"]})
        ).status_code == 422
        assert (
            await root.patch(f"/users/{other_id}", json={"directPermissions": ["root:all"]})
        ).status_code == 422


async def test_deactivation_kills_live_cookie_session(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """停用应使现有 cookie 会话在下一次请求失效，无需等待 JWT 到期。"""

    await register_and_login(client)
    await set_roles_in_db(migrated_pg, "logan@example.com", ["root"])

    async with make_client(app) as root, make_client(app) as member:
        await root.post("/auth/login", data={"username": "logan", "password": "password-123"})
        created = await member.post(
            "/auth/register",
            json={"email": "m2@example.com", "password": "password-123", "username": "m2"},
        )
        member_id = created.json()["id"]
        await member.post("/auth/login", data={"username": "m2", "password": "password-123"})
        assert (await member.get("/users/me")).status_code == 200

        assert (
            await root.patch(f"/users/{member_id}", json={"isActive": False})
        ).status_code == 200
        assert (await member.get("/users/me")).status_code == 401
