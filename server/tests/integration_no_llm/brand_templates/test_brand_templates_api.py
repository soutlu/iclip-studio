"""品牌模板端点：权限（治理者才能管，读要登录）、只收本人的视频上传、量出来的参数落库、时长上限、
改名与停用恢复、列表默认只列在用的；媒体生成没开时不挂。

媒体生成开着、对象存储与队列连接器是替身；量视频那一步换成替身，真 ffmpeg 的那一步另见
test_brand_template_adapters.py。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from iclip.app.bootstrap import build_app
from iclip.domains.brand_templates.models import MAX_TEMPLATE_MS, ProbedVideo
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.ffmpeg import MediaError
from tests.helpers.app import make_client
from tests.helpers.auth import set_roles_in_db
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.pg import reset_database

PASSWORD = "password-123"


class FakeProbe:
    """量视频的替身：交回预先写好的参数，记下量过哪些地址；``failure`` 给了就抛它。"""

    def __init__(self) -> None:
        self.video = ProbedVideo(width=1080, height=1920, duration_ms=3000, has_audio=True)
        self.failure: MediaError | None = None
        self.seen: list[str] = []

    async def __call__(self, url: str) -> ProbedVideo:
        self.seen.append(url)
        if self.failure is not None:
            raise self.failure
        return self.video


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
def probe() -> FakeProbe:
    return FakeProbe()


@pytest.fixture
async def media_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
    probe: FakeProbe,
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
            brand_template_probe=probe,
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


async def upload(
    client: httpx.AsyncClient,
    bucket: MemoryObjectStore,
    *,
    content_type: str = "video/mp4",
    ext: str = "mp4",
) -> tuple[str, str]:
    """走一遍直传：签名、把字节放进桶、确认；交回 ``(uploadId, url)``。"""

    signed = await client.post("/uploads/sign", json={"contentType": content_type})
    assert signed.status_code == 200, signed.text
    upload_id = signed.json()["uploadId"]
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{upload_id}.{ext}",
        content=uuid.uuid4().bytes * 4,
        content_type=content_type,
    )
    confirmed = await client.post(f"/uploads/{upload_id}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return upload_id, confirmed.json()["url"]


async def create(
    client: httpx.AsyncClient, upload_id: str, *, position: str = "intro", name: str = "品牌片头"
) -> httpx.Response:
    return await client.post(
        "/brand-templates", json={"position": position, "name": name, "uploadId": upload_id}
    )


async def listed(client: httpx.AsyncClient, **params: str) -> list[dict[str, object]]:
    response = await client.get("/brand-templates", params=params)
    assert response.status_code == 200, response.text
    return response.json()["items"]


async def test_anonymous_is_401(http: httpx.AsyncClient) -> None:
    template = uuid.uuid4()
    assert (await http.get("/brand-templates")).status_code == 401
    assert (await create(http, str(uuid.uuid4()))).status_code == 401
    assert (await http.patch(f"/brand-templates/{template}", json={"name": "x"})).status_code == 401


async def test_only_a_governor_manages_templates(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id, _ = await upload(http, bucket)
    created = await create(http, upload_id)
    assert created.status_code == 201, created.text
    template = created.json()["id"]

    await login_as(http, pg_url, "maya", "editor")
    own_upload, _ = await upload(http, bucket)

    assert (await create(http, own_upload)).status_code == 403
    assert (
        await http.patch(f"/brand-templates/{template}", json={"disabled": True})
    ).status_code == 403
    assert (
        await http.get("/brand-templates", params={"includeDisabled": "true"})
    ).status_code == 403
    assert [item["id"] for item in await listed(http)] == [template], "读得到在用的"


async def test_a_template_records_what_was_measured_from_the_callers_own_video(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, probe: FakeProbe
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id, url = await upload(http, bucket)
    probe.video = ProbedVideo(width=720, height=1280, duration_ms=4200, has_audio=False)

    created = await create(http, upload_id, position="outro", name="  夏季片尾  ")

    assert created.status_code == 201, created.text
    body = created.json()
    assert probe.seen == [url], "量的是那条上传的地址"
    assert {key: body[key] for key in body if key not in ("id", "createdAt")} == {
        "position": "outro",
        "name": "夏季片尾",
        "url": url,
        "width": 720,
        "height": 1280,
        "durationMs": 4200,
        "hasAudio": False,
        "disabledAt": None,
    }
    assert await listed(http) == [body], "读回来与新建时交回的一样"


@pytest.mark.parametrize("case", ["别人的", "音乐", "不存在"])
async def test_only_the_callers_own_video_upload_is_accepted(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, probe: FakeProbe, case: str
) -> None:
    if case == "别人的":
        await login_as(http, pg_url, "maya", "editor")
        upload_id, _ = await upload(http, bucket)
        await login_as(http, pg_url, "root", "root")
    else:
        await login_as(http, pg_url, "root", "root")
        upload_id = (
            (await upload(http, bucket, content_type="audio/mpeg", ext="mp3"))[0]
            if case == "音乐"
            else str(uuid.uuid4())
        )

    response = await create(http, upload_id)

    assert response.status_code == 404, response.text
    assert probe.seen == [], "不去量"
    assert await listed(http, includeDisabled="true") == []


async def test_a_video_longer_than_the_limit_or_unreadable_is_422(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, probe: FakeProbe
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id, _ = await upload(http, bucket)

    probe.video = ProbedVideo(width=1080, height=1920, duration_ms=MAX_TEMPLATE_MS, has_audio=True)
    at_limit = await create(http, upload_id)
    probe.video = ProbedVideo(
        width=1080, height=1920, duration_ms=MAX_TEMPLATE_MS + 1, has_audio=True
    )
    too_long = await create(http, upload_id)
    probe.failure = MediaError("ffprobe 读不了")
    unreadable = await create(http, upload_id)

    assert at_limit.status_code == 201, at_limit.text
    assert too_long.status_code == 422, too_long.text
    assert "片头片尾最长 10 秒" in too_long.json()["detail"]
    assert unreadable.status_code == 422, unreadable.text
    assert len(await listed(http, includeDisabled="true")) == 1


async def test_rename_disable_and_restore(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id, _ = await upload(http, bucket)
    intro = (await create(http, upload_id, position="intro")).json()
    outro = (await create(http, upload_id, position="outro", name="品牌片尾")).json()

    renamed = await http.patch(f"/brand-templates/{intro['id']}", json={"name": "新片头"})
    disabled = await http.patch(f"/brand-templates/{intro['id']}", json={"disabled": True})
    again = await http.patch(f"/brand-templates/{intro['id']}", json={"disabled": True})

    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["disabledAt"]) == ("新片头", None)
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["disabledAt"] is not None
    assert again.json()["disabledAt"] == disabled.json()["disabledAt"], "再停用不改停用时刻"
    assert [item["id"] for item in await listed(http)] == [outro["id"]], "默认只列在用的"
    assert [item["id"] for item in await listed(http, includeDisabled="true")] == [
        outro["id"],
        intro["id"],
    ], "治理者连停用的一起列，建立晚的在前"
    assert [item["id"] for item in await listed(http, position="intro")] == []
    assert [
        item["id"] for item in await listed(http, position="intro", includeDisabled="true")
    ] == [intro["id"]]

    await login_as(http, pg_url, "maya", "editor")
    assert [item["id"] for item in await listed(http)] == [outro["id"]], "别人看不到停用的"

    await login_as(http, pg_url, "root", "root")
    restored = await http.patch(f"/brand-templates/{intro['id']}", json={"disabled": False})

    assert restored.status_code == 200, restored.text
    assert (restored.json()["name"], restored.json()["disabledAt"]) == ("新片头", None)
    assert {item["id"] for item in await listed(http)} == {intro["id"], outro["id"]}


async def test_an_update_needs_something_to_change_and_an_existing_template(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id, _ = await upload(http, bucket)
    template = (await create(http, upload_id)).json()["id"]

    empty = await http.patch(f"/brand-templates/{template}", json={})
    blank = await http.patch(f"/brand-templates/{template}", json={"name": "   "})
    missing = await http.patch(f"/brand-templates/{uuid.uuid4()}", json={"name": "x"})

    assert (empty.status_code, blank.status_code, missing.status_code) == (422, 422, 404)


@pytest.mark.parametrize("kind", ["font", "sound_effect"])
async def test_video_template_endpoints_do_not_list_or_modify_other_resources(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, kind: str
) -> None:
    await login_as(http, pg_url, "root", "root")
    upload_id, _ = await upload(http, bucket)
    video = (await create(http, upload_id)).json()
    resource_id = uuid.uuid4()
    engine = build_engine(pg_url)
    try:
        async with engine.begin() as conn:
            before = (
                (
                    await conn.execute(
                        text(
                            "INSERT INTO iclip.brand_templates (id, kind, brand, name, url, created_by)"
                            " SELECT :id, :kind, 'DP', '品牌资源', :url, created_by"
                            " FROM iclip.brand_templates WHERE id = :video_id RETURNING *"
                        ),
                        {
                            "id": resource_id,
                            "kind": kind,
                            "url": f"https://cdn.example.test/{kind}",
                            "video_id": uuid.UUID(video["id"]),
                        },
                    )
                )
                .mappings()
                .one()
            )

        assert await listed(http) == [video]
        assert await listed(http, includeDisabled="true") == [video]
        changed = await http.patch(
            f"/brand-templates/{resource_id}", json={"name": "不应修改", "disabled": True}
        )
        assert changed.status_code == 404, changed.text
        async with engine.connect() as conn:
            after = (
                (
                    await conn.execute(
                        text("SELECT * FROM iclip.brand_templates WHERE id = :id"),
                        {"id": resource_id},
                    )
                )
                .mappings()
                .one()
            )
        assert after == before
    finally:
        await engine.dispose()


async def test_without_media_generation_the_endpoints_are_not_mounted(app: FastAPI) -> None:
    async with make_client(app) as client:
        assert (await client.get("/brand-templates")).status_code == 404
