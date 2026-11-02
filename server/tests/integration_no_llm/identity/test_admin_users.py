"""用户管理面：分页信封、users:manage 门控、自我保护规则与管理上限。"""

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


BEYOND_OWN = {"detail": "不能修改权限超出自己的用户，也不能授予超出自己的权限"}


async def test_manager_cannot_touch_users_with_more_permissions(
    app: FastAPI, migrated_pg: str
) -> None:
    """admin 停用、降级 root，或原样重发 root 的角色，都是 403，root 保持原样。"""

    async with make_client(app) as root, make_client(app) as admin:
        root_id = await register_and_login(root, username="rose", email="rose@example.com")
        await set_roles_in_db(migrated_pg, "rose@example.com", ["root"])
        await register_and_login(admin, username="ada", email="ada@example.com")
        await set_roles_in_db(migrated_pg, "ada@example.com", ["admin"])

        deactivated = await admin.patch(f"/users/{root_id}", json={"isActive": False})
        assert deactivated.status_code == 403
        assert deactivated.json() == BEYOND_OWN
        demoted = await admin.patch(f"/users/{root_id}", json={"roles": ["editor"]})
        assert demoted.status_code == 403
        assert demoted.json() == BEYOND_OWN
        resent = await admin.patch(f"/users/{root_id}", json={"roles": ["root"]})
        assert resent.status_code == 403

        me = (await root.get("/users/me")).json()["user"]
        assert me["roles"] == ["root"]
        assert me["isActive"] is True


async def test_manager_cannot_grant_beyond_own_permissions(app: FastAPI, migrated_pg: str) -> None:
    """admin 把别人设成 root、直接授予自己没有的权限都是 403，对方保持原样。"""

    async with make_client(app) as admin, make_client(app) as editor:
        await register_and_login(admin, username="ada", email="ada@example.com")
        await set_roles_in_db(migrated_pg, "ada@example.com", ["admin"])
        editor_id = await register_and_login(editor, username="mia", email="mia@example.com")
        await set_roles_in_db(migrated_pg, "mia@example.com", ["editor"])

        to_root = await admin.patch(f"/users/{editor_id}", json={"roles": ["root"]})
        assert to_root.status_code == 403
        assert to_root.json() == BEYOND_OWN
        direct = await admin.patch(
            f"/users/{editor_id}", json={"directPermissions": ["agent:manage"]}
        )
        assert direct.status_code == 403
        assert direct.json() == BEYOND_OWN

        me = (await editor.get("/users/me")).json()["user"]
        assert me["roles"] == ["editor"]
        assert me["directPermissions"] == []


async def test_manager_edits_users_within_own_permissions(app: FastAPI, migrated_pg: str) -> None:
    """admin 能把 editor 升为 admin、改另一个 admin、停用 editor。"""

    async with make_client(app) as admin, make_client(app) as member:
        await register_and_login(admin, username="ada", email="ada@example.com")
        await set_roles_in_db(migrated_pg, "ada@example.com", ["admin"])
        member_id = await register_and_login(member, username="mia", email="mia@example.com")
        await set_roles_in_db(migrated_pg, "mia@example.com", ["editor"])

        promoted = await admin.patch(f"/users/{member_id}", json={"roles": ["admin"]})
        assert promoted.status_code == 200, promoted.text
        assert promoted.json()["user"]["roles"] == ["admin"]

        demoted = await admin.patch(f"/users/{member_id}", json={"roles": ["editor"]})
        assert demoted.status_code == 200, demoted.text
        assert demoted.json()["user"]["roles"] == ["editor"]

        deactivated = await admin.patch(f"/users/{member_id}", json={"isActive": False})
        assert deactivated.status_code == 200, deactivated.text
        assert deactivated.json()["user"]["isActive"] is False


async def test_root_manages_anyone(app: FastAPI, migrated_pg: str) -> None:
    """root 持有全部权限，停用、降级 admin 与把别人设成 root 都照常。"""

    async with (
        make_client(app) as root,
        make_client(app) as admin,
        make_client(app) as member,
    ):
        await register_and_login(root, username="rose", email="rose@example.com")
        await set_roles_in_db(migrated_pg, "rose@example.com", ["root"])
        admin_id = await register_and_login(admin, username="ada", email="ada@example.com")
        await set_roles_in_db(migrated_pg, "ada@example.com", ["admin"])
        member_id = await register_and_login(member, username="mia", email="mia@example.com")

        deactivated = await root.patch(f"/users/{admin_id}", json={"isActive": False})
        assert deactivated.status_code == 200, deactivated.text
        assert deactivated.json()["user"]["isActive"] is False
        demoted = await root.patch(f"/users/{admin_id}", json={"roles": ["editor"]})
        assert demoted.status_code == 200, demoted.text
        assert demoted.json()["user"]["roles"] == ["editor"]

        made_root = await root.patch(f"/users/{member_id}", json={"roles": ["root"]})
        assert made_root.status_code == 200, made_root.text
        assert made_root.json()["user"]["roles"] == ["root"]


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
