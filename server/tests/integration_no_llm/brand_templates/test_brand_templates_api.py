"""品牌模板端点：权限（治理者才能管，读要 ``generation:read``）、字体上传与读取、改名与停用恢复、
列表默认只列在用的；媒体生成没开时不挂。

媒体生成开着、对象存储与队列连接器是替身；读字体那一步换成替身，真解析另见
test_brand_template_adapters.py。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from iclip.app.bootstrap import build_app
from iclip.domains.brand_templates.service import UNREADABLE_FONT
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fonts import MAX_FONT_BYTES, FontError, FontInfo
from tests.helpers.app import make_client
from tests.helpers.auth import set_roles_in_db
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.pg import reset_database

PASSWORD = "password-123"


class FakeFontProbe:
    """字体探测端口替身；真实字体解析另在媒体层验证。"""

    def __init__(self) -> None:
        self.info = FontInfo(
            family="Test Family", weight=600, style="normal", unicode_ranges=((32, 126),)
        )
        self.failure: MediaError | None = None

    async def __call__(self, url: str) -> FontInfo:
        if self.failure is not None:
            raise self.failure
        return self.info


@pytest.fixture
def font_probe() -> FakeFontProbe:
    return FakeFontProbe()


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
async def media_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
    font_probe: FakeFontProbe,
) -> AsyncGenerator[FastAPI]:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = build_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    try:
        yield build_app(
            config_with_media(),
            engine=engine,
            object_store=bucket,
            queue_connector=InMemoryConnector(),
            brand_font_probe=font_probe,
            media_codec=SOFTWARE,
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def http(media_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(media_app) as client:
        yield client


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> None:
    """第一次叫到这个名字就注册，之后只是重新登录。"""

    email = f"{username}@example.com"
    created = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "username": username}
    )
    if created.status_code == 201:
        await set_roles_in_db(pg_url, email, [role])
    logged_in = await client.post("/auth/login", data={"username": username, "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text


async def font_upload(client: httpx.AsyncClient, bucket: MemoryObjectStore) -> str:
    signed = await client.post("/brand-templates/fonts/sign", json={"contentType": "font/ttf"})
    assert signed.status_code == 200, signed.text
    ticket = signed.json()
    await bucket.put_public_object(
        object_key=urlsplit(ticket["upload"]["url"]).path.lstrip("/"),
        content=b"font bytes checked by the probe",
        content_type="font/ttf",
    )
    return ticket["uploadId"]


async def add_font(
    client: httpx.AsyncClient,
    bucket: MemoryObjectStore,
    *,
    name: str = "品牌字体",
    brand: str | None = None,
) -> dict[str, Any]:
    """传一份字体并确认，交回资源。"""

    upload_id = await font_upload(client, bucket)
    confirmed = await client.post(
        f"/brand-templates/fonts/{upload_id}/confirm", json={"name": name, "brand": brand}
    )
    assert confirmed.status_code == 201, confirmed.text
    return confirmed.json()


async def listed(client: httpx.AsyncClient, **params: str) -> list[dict[str, object]]:
    response = await client.get("/brand-templates", params=params)
    assert response.status_code == 200, response.text
    return response.json()["items"]


async def test_anonymous_is_401(http: httpx.AsyncClient) -> None:
    template = uuid.uuid4()
    assert (await http.get("/brand-templates")).status_code == 401
    assert (await http.patch(f"/brand-templates/{template}", json={"name": "x"})).status_code == 401


async def test_only_a_governor_manages_templates(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "root", "root")
    template = (await add_font(http, bucket, brand="N8"))["id"]

    await login_as(http, pg_url, "maya", "editor")

    assert (
        await http.patch(f"/brand-templates/{template}", json={"disabled": True})
    ).status_code == 403
    assert (
        await http.get("/brand-templates", params={"includeDisabled": "true"})
    ).status_code == 403
    assert [item["id"] for item in await listed(http)] == [template], "读得到在用的"


async def test_rename_disable_and_restore(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "root", "root")
    first = await add_font(http, bucket, name="正文字体")
    second = await add_font(http, bucket, name="标题字体")

    renamed = await http.patch(f"/brand-templates/{first['id']}", json={"name": "新正文"})
    disabled = await http.patch(f"/brand-templates/{first['id']}", json={"disabled": True})
    again = await http.patch(f"/brand-templates/{first['id']}", json={"disabled": True})

    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["disabledAt"]) == ("新正文", None)
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["disabledAt"] is not None
    assert again.json()["disabledAt"] == disabled.json()["disabledAt"], "再停用不改停用时刻"
    assert [item["id"] for item in await listed(http)] == [second["id"]], "默认只列在用的"
    assert [item["id"] for item in await listed(http, includeDisabled="true")] == [
        second["id"],
        first["id"],
    ], "治理者连停用的一起列，建立晚的在前"

    await login_as(http, pg_url, "maya", "editor")
    assert [item["id"] for item in await listed(http)] == [second["id"]], "别人看不到停用的"

    await login_as(http, pg_url, "root", "root")
    restored = await http.patch(f"/brand-templates/{first['id']}", json={"disabled": False})

    assert restored.status_code == 200, restored.text
    assert (restored.json()["name"], restored.json()["disabledAt"]) == ("新正文", None)
    assert {item["id"] for item in await listed(http)} == {first["id"], second["id"]}


async def test_an_update_needs_something_to_change_and_an_existing_template(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "root", "root")
    template = (await add_font(http, bucket))["id"]

    empty = await http.patch(f"/brand-templates/{template}", json={})
    blank = await http.patch(f"/brand-templates/{template}", json={"name": "   "})
    missing = await http.patch(f"/brand-templates/{uuid.uuid4()}", json={"name": "x"})

    assert (empty.status_code, blank.status_code, missing.status_code) == (422, 422, 404)


async def test_without_media_generation_the_endpoints_are_not_mounted(app: FastAPI) -> None:
    async with make_client(app) as client:
        assert (await client.get("/brand-templates")).status_code == 404


async def test_font_upload_is_idempotent_and_never_creates_a_generation(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, font_probe: FakeFontProbe
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id = await font_upload(http, bucket)
    created = await http.post(
        f"/brand-templates/fonts/{upload_id}/confirm", json={"name": "品牌字体", "brand": "N8"}
    )
    assert created.status_code == 201, created.text
    resource = created.json()
    assert resource["id"] == upload_id
    assert resource["kind"] == "font"
    assert resource["brand"] == "N8"
    assert set(resource) == {"id", "kind", "brand", "name", "url", "createdAt", "disabledAt"}
    repeated = await http.post(
        f"/brand-templates/fonts/{upload_id}/confirm", json={"name": "不应覆盖", "brand": "DP"}
    )
    assert repeated.json() == resource
    assert await listed(http, kind="font", brand="N8") == [resource]
    engine = build_engine(pg_url)
    try:
        async with engine.connect() as conn:
            assert (
                await conn.execute(text("SELECT count(*) FROM iclip.generation_jobs"))
            ).scalar_one() == 0
    finally:
        await engine.dispose()
    changed = await http.patch(f"/brand-templates/{upload_id}", json={"brand": None})
    assert changed.status_code == 200 and changed.json()["brand"] is None
    assert (
        await http.patch(f"/brand-templates/{upload_id}", json={"brand": " \t\n"})
    ).status_code == 422
    await http.patch(f"/brand-templates/{upload_id}", json={"disabled": True})
    await login_as(http, pg_url, "maya", "editor")
    assert await listed(http, kind="font") == []
    info = await http.get(f"/brand-templates/{upload_id}/font-info")
    assert info.status_code == 200
    assert info.json() == {
        "family": "Test Family",
        "weight": 600,
        "style": "normal",
        "unicodeRanges": [{"start": 32, "end": 126}],
    }


async def test_font_upload_checks_authority_ownership_and_actual_font(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, font_probe: FakeFontProbe
) -> None:
    assert (
        await http.post("/brand-templates/fonts/sign", json={"contentType": "font/ttf"})
    ).status_code == 401
    await login_as(http, pg_url, "maya", "editor")
    assert (
        await http.post("/brand-templates/fonts/sign", json={"contentType": "font/ttf"})
    ).status_code == 403
    await login_as(http, pg_url, "root", "root")
    assert (
        await http.post("/brand-templates/fonts/sign", json={"contentType": "font/woff"})
    ).status_code == 422
    upload_id = await font_upload(http, bucket)
    font_probe.failure = FontError("暂不支持可变字体，请选择静态 TTF/OTF")
    rejected = await http.post(f"/brand-templates/fonts/{upload_id}/confirm", json={"name": "字体"})
    assert rejected.status_code == 422 and "不支持可变字体" in rejected.json()["detail"]
    assert await listed(http) == []
    font_probe.failure = None
    await login_as(http, pg_url, "other-root", "root")
    wrong_owner = await http.post(
        f"/brand-templates/fonts/{upload_id}/confirm", json={"name": "字体"}
    )
    assert wrong_owner.status_code == 409, wrong_owner.text
    assert await listed(http) == []
    await login_as(http, pg_url, "root", "root")
    accepted = await http.post(f"/brand-templates/fonts/{upload_id}/confirm", json={"name": "字体"})
    assert accepted.status_code == 201
    await login_as(http, pg_url, "other-root", "root")
    assert (
        await http.post(f"/brand-templates/fonts/{upload_id}/confirm", json={"name": "字体"})
    ).status_code == 404


async def test_font_info_rejects_a_non_font_missing_or_unreadable_resource(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, font_probe: FakeFontProbe
) -> None:
    await login_as(http, pg_url, "root", "root")
    font = await add_font(http, bucket)
    other = uuid.uuid4()
    engine = build_engine(pg_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.brand_templates (id, kind, name, url, created_by)"
                    " SELECT :id, 'sound_effect', '音效', 'https://cdn.example.test/s.mp3',"
                    " created_by FROM iclip.brand_templates WHERE id = :font"
                ),
                {"id": other, "font": uuid.UUID(font["id"])},
            )
    finally:
        await engine.dispose()

    assert (await http.get(f"/brand-templates/{other}/font-info")).status_code == 422
    assert (await http.get(f"/brand-templates/{uuid.uuid4()}/font-info")).status_code == 404
    font_probe.failure = MediaError("取不到素材（ConnectError）: https://internal.example.test/f")
    failed = await http.get(f"/brand-templates/{font['id']}/font-info")
    assert failed.status_code == 422
    assert failed.json()["detail"] == UNREADABLE_FONT
    assert "internal.example.test" not in failed.text


@pytest.mark.parametrize("invalid_type", [False, True], ids=["oversize", "wrong-mime"])
async def test_font_confirmation_checks_object_metadata_before_parsing(
    http: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    invalid_type: bool,
) -> None:
    await login_as(http, pg_url, "root", "root")
    signed = await http.post("/brand-templates/fonts/sign", json={"contentType": "font/ttf"})
    ticket = signed.json()
    await bucket.put_public_object(
        object_key=urlsplit(ticket["upload"]["url"]).path.lstrip("/"),
        content=b"x" if invalid_type else b"x" * (MAX_FONT_BYTES + 1),
        content_type="image/png" if invalid_type else "font/ttf",
    )
    response = await http.post(
        f"/brand-templates/fonts/{ticket['uploadId']}/confirm", json={"name": "字体"}
    )
    assert response.status_code == 422
    assert await listed(http, kind="font") == []
