"""使用 bucket 与记录替身验证上传签名、审计头、权限、确认规则与记在谁名下。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI
from structlog.testing import capture_logs

from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    MediaKind,
)
from iclip.domains.uploads.service import API_KEY_HEADER, UPLOADER_HEADER, UploadService
from tests.helpers.app import app_with_principal
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.uploads import FakeBucket


def uploader(user_id: uuid.UUID | None = None, *, api_key_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user" if api_key_id is None else "api_key",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset({"uploads:write"}),
        audit_label="tester",
        api_key_id=api_key_id,
        username="tester",
        key_name=None if api_key_id is None else "gateway",
    )


@dataclass(frozen=True)
class Recorded:
    url: str
    object_upload_id: uuid.UUID


RecordCall = tuple[Principal, uuid.UUID, MediaKind, str, str | None]


@dataclass
class RecordedUploads:
    """RecordUpload 与 FindRecordedUpload 的替身：记下每次确认记给了谁、哪一次上传、什么种类、
    什么地址、什么 MD5，按 upload_id 存一条记录。``earlier`` 给了就当同一个文件早先传过，记录的
    地址落它的；去不去重由生成域判断，这里不复制那条规则。"""

    calls: list[RecordCall] = field(default_factory=list[RecordCall])
    rows: dict[uuid.UUID, Recorded] = field(default_factory=dict[uuid.UUID, Recorded])
    earlier: Recorded | None = None

    async def record(
        self,
        principal: Principal,
        *,
        upload_id: uuid.UUID,
        kind: MediaKind,
        url: str,
        content_md5: str | None,
    ) -> Recorded:
        self.calls.append((principal, upload_id, kind, url, content_md5))
        return self.rows.setdefault(upload_id, self.earlier or Recorded(url, upload_id))

    async def find(self, upload_id: uuid.UUID) -> Recorded | None:
        return self.rows.get(upload_id)


def build_test_app(
    bucket: FakeBucket, *, granted: Principal | None, recorded: RecordedUploads | None = None
) -> FastAPI:
    app = app_with_principal(granted)
    records = recorded or RecordedUploads()
    service = UploadService(bucket, record=records.record, find_recorded=records.find)
    app.include_router(create_uploads_router(service, act_as=ActAs(InMemoryUserRepository())))
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


async def sign(
    http: httpx.AsyncClient,
    content_type: str = "image/jpeg",
    *,
    width: int | None = 1200,
    height: int | None = 1600,
) -> httpx.Response:
    body: dict[str, object] = {"contentType": content_type}
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    return await http.post("/uploads/sign", json=body)


async def confirm(
    http: httpx.AsyncClient, upload_id: str, *, user_name: str | None = None
) -> httpx.Response:
    if user_name is None:
        return await http.post(f"/uploads/{upload_id}/confirm")
    return await http.post(f"/uploads/{upload_id}/confirm", json={"userName": user_name})


@pytest.mark.parametrize("path", ["/uploads/sign", f"/uploads/{uuid.uuid4()}/confirm"])
async def test_no_principal_is_unauthorized(path: str) -> None:
    app = build_test_app(FakeBucket(), granted=None)
    async with client(app) as http:
        response = await http.post(path, json={"contentType": "image/jpeg"})

    assert response.status_code == 401


async def test_both_steps_need_uploads_write() -> None:
    reader = Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset({"inspirations:read"}),
        audit_label="tester",
    )
    app = build_test_app(FakeBucket(), granted=reader)
    async with client(app) as http:
        assert (await sign(http)).status_code == 403
        assert (await confirm(http, str(uuid.uuid4()))).status_code == 403


async def test_sign_mints_the_name_and_signs_the_uploader_in() -> None:
    """名字在字节落地前发下来；上传者签进请求头，浏览器原样带上才能通过验签。"""

    bucket = FakeBucket()
    me = uuid.uuid4()
    app = build_test_app(bucket, granted=uploader(me))
    async with client(app) as http:
        response = await sign(http, "video/mp4")

    body = response.json()
    upload_id = uuid.UUID(body["uploadId"])
    headers = {"Content-Type": "video/mp4", UPLOADER_HEADER: str(me)}
    assert body["upload"]["method"] == "PUT"
    assert body["upload"]["headers"] == headers
    assert body["upload"]["url"] == f"https://cdn.test/iclip/agent/uploads/{upload_id}.mp4?signed"
    assert bucket.signed == [(f"iclip/agent/uploads/{upload_id}.mp4", headers)]
    assert datetime.fromisoformat(body["upload"]["expiresAt"]) > datetime.now(UTC)


async def test_key_uploads_also_sign_the_key_in() -> None:
    bucket = FakeBucket()
    me, key = uuid.uuid4(), uuid.uuid4()
    app = build_test_app(bucket, granted=uploader(me, api_key_id=key))
    async with client(app) as http:
        body = (await sign(http)).json()

    assert body["upload"]["headers"] == {
        "Content-Type": "image/jpeg",
        UPLOADER_HEADER: str(me),
        API_KEY_HEADER: str(key),
    }
    assert bucket.signed[0][1] == body["upload"]["headers"]


@pytest.mark.parametrize("content_type", ["application/pdf", "image/gif", "", "视频"])
async def test_unsupported_types_are_refused_before_signing(content_type: str) -> None:
    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        response = await sign(http, content_type)

    assert response.status_code == 422
    assert bucket.signed == []


@pytest.mark.parametrize(
    ("width", "height"),
    [
        (MIN_SHORT_EDGE_PIXELS - 1, 4000),
        (4000, MIN_SHORT_EDGE_PIXELS - 1),
        (MAX_LONG_EDGE_PIXELS + 1, 4000),
        (4000, MAX_LONG_EDGE_PIXELS + 1),
    ],
)
async def test_out_of_range_images_are_refused_before_signing(width: int, height: int) -> None:
    bucket = FakeBucket()
    app = build_test_app(bucket, granted=uploader())
    async with client(app) as http:
        response = await sign(http, width=width, height=height)

    assert response.status_code == 422
    assert bucket.signed == []


@pytest.mark.parametrize(
    ("width", "height"),
    [(MIN_SHORT_EDGE_PIXELS, MIN_SHORT_EDGE_PIXELS), (MAX_LONG_EDGE_PIXELS, MAX_LONG_EDGE_PIXELS)],
)
async def test_the_bounds_themselves_pass(width: int, height: int) -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        assert (await sign(http, width=width, height=height)).status_code == 200


async def test_an_image_must_report_its_size() -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        assert (await sign(http, width=None, height=None)).status_code == 422
        assert (await sign(http, width=1200, height=None)).status_code == 422


async def test_video_needs_no_size() -> None:
    app = build_test_app(FakeBucket(), granted=uploader())
    async with client(app) as http:
        assert (await sign(http, "video/mp4", width=None, height=None)).status_code == 200


async def test_oversized_upload_is_refused() -> None:
    """预签名 PUT 无法限制长度，确认时须校验桶内实际大小。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(
            f"iclip/agent/uploads/{upload_id}.jpg",
            content_type="image/jpeg",
            size_bytes=MAX_BYTES["image"] + 1,
        )
        response = await confirm(http, upload_id)

    assert response.status_code == 422
    assert recorded.calls == [], "核对不过不记录"


async def test_unexpected_type_in_the_bucket_is_refused() -> None:
    """Content-Type 签进了签名里，桶里仍可能出现别的类型（改过 CORS 或 SDK 直传），确认时按桶里的算。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="application/pdf")
        response = await confirm(http, upload_id)

    assert response.status_code == 422
    assert recorded.calls == [], "核对不过不记录"


# --- 确认即记录 -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("caller", "name", "owner"),
    [
        ("browser", None, "self"),
        ("browser", "tester", "self"),
        ("key", None, "self"),
        ("key", "Sara.Hong", "self"),
        ("act_as_key", None, "self"),
        ("act_as_key", "Sara.Hong", "named"),
    ],
    ids=[
        "浏览器不给名字",
        "浏览器给自己的名字",
        "钥匙不给名字",
        "钥匙给了名字但不能替人办事",
        "替人办事的钥匙不给名字",
        "替人办事的钥匙给了名字",
    ],
)
async def test_the_upload_is_recorded_under_whoever_confirms_it(
    caller: str, name: str | None, owner: str
) -> None:
    """名字可选：给了才按替人办事换主体，不给就记在当前主体名下，钥匙不带名字也不报错；钥匙身份照记。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    key_id = None if caller == "browser" else uuid.uuid4()
    me = uploader(api_key_id=key_id)
    if caller == "act_as_key":
        me = Principal(
            kind="api_key",
            user_id=me.user_id,
            permissions=frozenset({"uploads:write", ACT_AS_PERMISSION}),
            audit_label="logan#gateway",
            api_key_id=key_id,
            username="logan",
            key_name="gateway",
        )
    app = build_test_app(bucket, granted=me, recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="image/jpeg")
        response = await confirm(http, upload_id, user_name=name)

    assert response.status_code == 200, response.text
    ((recorded_as, _, _, _, _),) = recorded.calls
    assert recorded_as.api_key_id == key_id
    if owner == "self":
        assert recorded_as.user_id == me.user_id
    else:
        assert (recorded_as.user_id != me.user_id, recorded_as.username) == (True, "Sara.Hong")


async def test_a_browser_may_not_confirm_in_someone_elses_name() -> None:
    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="image/jpeg")
        response = await confirm(http, upload_id, user_name="Sara.Hong")

    assert response.status_code == 422
    assert recorded.calls == []


# --- 视频按内容去重 -----------------------------------------------------------------

MD5_ETAG = "0123456789ABCDEF0123456789ABCDEF"


async def test_a_video_put_in_one_go_is_recorded_with_its_md5() -> None:
    """一次整传的视频，ETag 就是 MD5：照小写记下，交回本次的地址。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http, "video/mp4", width=None, height=None)).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.mp4"
        bucket.put(key, content_type="video/mp4", etag=MD5_ETAG)
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert response.json()["url"] == bucket.public_url(key)
    ((_, _, kind, _, content_md5),) = recorded.calls
    assert (kind, content_md5) == ("video", MD5_ETAG.lower())
    assert key in bucket.objects


@pytest.mark.parametrize(
    ("content_type", "ext", "etag", "object_type"),
    [
        ("image/jpeg", "jpg", MD5_ETAG, "Normal"),
        ("video/mp4", "mp4", MD5_ETAG, "Multipart"),
        ("video/mp4", "mp4", MD5_ETAG, "Appendable"),
        ("video/mp4", "mp4", f"{MD5_ETAG[:-2]}-3", "Normal"),
        ("video/mp4", "mp4", None, "Normal"),
        ("video/mp4", "mp4", MD5_ETAG, None),
    ],
    ids=["图片", "分片上传", "追加上传", "ETag 不是 MD5", "没有 ETag", "没有对象类型"],
)
async def test_only_a_video_put_in_one_go_gets_an_md5(
    content_type: str, ext: str, etag: str | None, object_type: str | None
) -> None:
    """图片、不是一次整传的视频不记 MD5，照旧交回本次的地址。"""

    bucket = FakeBucket()
    recorded = RecordedUploads()
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http, content_type)).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.{ext}"
        bucket.put(key, content_type=content_type, etag=etag, object_type=object_type)
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert response.json()["url"] == bucket.public_url(key)
    ((_, _, _, _, content_md5),) = recorded.calls
    assert content_md5 is None


def seed_earlier(bucket: FakeBucket, *, size_bytes: int = 70) -> Recorded:
    """桶里放一份早先传过的视频，交回它那条记录。"""

    first = uuid.uuid4()
    key = f"iclip/agent/uploads/{first}.mp4"
    bucket.put(key, content_type="video/mp4", size_bytes=size_bytes, etag=MD5_ETAG)
    return Recorded(bucket.public_url(key), first)


async def test_a_duplicate_hands_back_the_earlier_address_and_drops_this_copy() -> None:
    """记录交回别人先传的地址：交回那个地址与那份对象的类型、大小，删掉本次传上来的对象。"""

    bucket = FakeBucket()
    earlier = seed_earlier(bucket)
    recorded = RecordedUploads(earlier=earlier)
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http, "video/quicktime")).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.mov"
        bucket.put(key, content_type="video/quicktime", size_bytes=70, etag=MD5_ETAG)
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert response.json() == {"url": earlier.url, "contentType": "video/mp4", "sizeBytes": 70}
    assert key not in bucket.objects, "本次的对象删掉了"
    assert f"iclip/agent/uploads/{earlier.object_upload_id}.mp4" in bucket.objects


async def test_confirming_a_recorded_upload_again_answers_from_the_shared_object() -> None:
    """记过的上传再确认：本次的对象已经删了，照样交回记录上的地址与那份对象的事实，不再记一次。"""

    bucket = FakeBucket()
    earlier = seed_earlier(bucket, size_bytes=90)
    upload_id = uuid.uuid4()
    recorded = RecordedUploads(rows={upload_id: earlier})
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        response = await confirm(http, str(upload_id))

    assert response.status_code == 200, response.text
    assert response.json() == {"url": earlier.url, "contentType": "video/mp4", "sizeBytes": 90}
    assert recorded.calls == []


async def test_a_copy_that_cannot_be_dropped_still_confirms_and_leaves_a_warning() -> None:
    bucket = FakeBucket()
    bucket.delete_fails = True
    earlier = seed_earlier(bucket)
    recorded = RecordedUploads(earlier=earlier)
    app = build_test_app(bucket, granted=uploader(), recorded=recorded)
    async with client(app) as http:
        upload_id = (await sign(http, "video/mp4", width=None, height=None)).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.mp4"
        bucket.put(key, content_type="video/mp4", etag=MD5_ETAG)
        with capture_logs() as logs:
            response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert response.json()["url"] == earlier.url
    warnings = [entry for entry in logs if entry["log_level"] == "warning"]
    assert [(entry["upload_id"], entry["object_key"]) for entry in warnings] == [
        (uuid.UUID(upload_id), key)
    ]
    assert key in bucket.objects
