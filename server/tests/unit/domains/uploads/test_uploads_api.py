from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from io import BytesIO
from typing import NoReturn

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image
from structlog.testing import capture_logs

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    Inheritance,
    MediaUpload,
)
from iclip.domains.uploads.service import UploadService
from iclip.platform.object_store.direct_upload import API_KEY_HEADER, UPLOADER_HEADER
from iclip.platform.object_store.store import ObjectStoreUnavailable
from iclip.platform.outbound.fetch import FetchTooLarge
from iclip.platform.outbound.guard import FetchFailed
from tests.helpers.app import app_with_principal
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.media import multi_picture_jpeg
from tests.helpers.uploads import FakeBucket, InMemoryUploadRepository


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


@dataclass
class FakeFetch:
    body: bytes = b""
    error: Exception | None = None
    calls: list[tuple[str, int]] = field(default_factory=list[tuple[str, int]])

    async def __call__(self, url: str, *, max_bytes: int) -> bytes:
        self.calls.append((url, max_bytes))
        if self.error is not None:
            raise self.error
        return self.body


async def no_conversation(_principal: Principal, _conversation_id: uuid.UUID) -> NoReturn:
    raise AssertionError("挂对话的确认在集成测试里覆盖")


class NoLineage:
    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance:
        raise AssertionError("列上传在集成测试里覆盖")

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        raise AssertionError("列上传在集成测试里覆盖")


def upload_service(
    bucket: FakeBucket, repo: InMemoryUploadRepository, *, fetch: FakeFetch | None = None
) -> UploadService:
    return UploadService(
        bucket,
        repo,
        fetch=fetch or FakeFetch(),
        conversation_writable=no_conversation,
        lineage=NoLineage(),
    )


def build_test_app(
    bucket: FakeBucket, *, granted: Principal | None, repo: InMemoryUploadRepository | None = None
) -> FastAPI:
    app = app_with_principal(granted)
    service = upload_service(bucket, repo or InMemoryUploadRepository())
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
    http: httpx.AsyncClient, upload_id: str, body: dict[str, object] | None = None
) -> httpx.Response:
    return await http.post(f"/uploads/{upload_id}/confirm", json=body)


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
async def test_image_dimension_bounds_are_inclusive(width: int, height: int) -> None:
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


@pytest.mark.parametrize(
    ("content_type", "ext", "width", "height"),
    [
        ("image/png", "png", 1200, 1600),
        ("video/mp4", "mp4", None, None),
        ("audio/mpeg", "mp3", None, None),
    ],
    ids=["图片记报上来的宽高", "视频不记宽高", "音频不记宽高"],
)
async def test_confirming_records_what_the_bucket_reports_and_the_images_reported_size(
    content_type: str, ext: str, width: int | None, height: int | None
) -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    me = uuid.uuid4()
    app = build_test_app(bucket, granted=uploader(me), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http, content_type)).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.{ext}"
        bucket.put(key, content_type=content_type, size_bytes=4096)
        response = await confirm(http, upload_id, {"width": 1200, "height": 1600})

    assert response.status_code == 200, response.text
    stored = repo.rows[uuid.UUID(upload_id)]
    assert response.json() == {
        "id": upload_id,
        "kind": stored.kind,
        "url": bucket.public_url(key),
        "contentType": content_type,
        "sizeBytes": 4096,
        "durationMs": None,
        "width": width,
        "height": height,
        "conversationId": None,
        "createdAt": stored.created_at.isoformat().replace("+00:00", "Z"),
    }
    assert (stored.owner_user_id, stored.duration_ms, stored.width, stored.height) == (
        me,
        None,
        width,
        height,
    ), "确认时不量时长"


async def test_an_image_confirmed_without_its_size_is_recorded_without_one() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    app = build_test_app(bucket, granted=uploader(), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="image/jpeg")
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert (response.json()["width"], response.json()["height"]) == (None, None)


async def test_an_image_size_out_of_range_at_confirm_is_refused_and_not_recorded() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    app = build_test_app(bucket, granted=uploader(), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="image/jpeg")
        response = await confirm(
            http, upload_id, {"width": MIN_SHORT_EDGE_PIXELS - 1, "height": 1600}
        )

    assert response.status_code == 422
    assert repo.rows == {}


async def test_music_over_its_own_limit_is_refused() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    app = build_test_app(bucket, granted=uploader(), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http, "audio/mpeg", width=None, height=None)).json()["uploadId"]
        bucket.put(
            f"iclip/agent/uploads/{upload_id}.mp3",
            content_type="audio/mpeg",
            size_bytes=MAX_BYTES["audio"] + 1,
        )
        response = await confirm(http, upload_id)

    assert MAX_BYTES["audio"] == 50 * 1024 * 1024
    assert response.status_code == 422
    assert "50MB" in response.json()["detail"]
    assert repo.rows == {}, "核对不过不记录"


async def test_oversized_upload_is_refused() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    app = build_test_app(bucket, granted=uploader(), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(
            f"iclip/agent/uploads/{upload_id}.jpg",
            content_type="image/jpeg",
            size_bytes=MAX_BYTES["image"] + 1,
        )
        response = await confirm(http, upload_id)

    assert response.status_code == 422
    assert repo.rows == {}, "核对不过不记录"


async def test_unexpected_type_in_the_bucket_is_refused() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    app = build_test_app(bucket, granted=uploader(), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http)).json()["uploadId"]
        bucket.put(f"iclip/agent/uploads/{upload_id}.jpg", content_type="application/pdf")
        response = await confirm(http, upload_id)

    assert response.status_code == 422
    assert repo.rows == {}, "核对不过不记录"


MD5_ETAG = "0123456789ABCDEF0123456789ABCDEF"


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
async def test_ineligible_uploads_are_recorded_without_md5(
    content_type: str, ext: str, etag: str | None, object_type: str | None
) -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    app = build_test_app(bucket, granted=uploader(), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http, content_type)).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.{ext}"
        bucket.put(key, content_type=content_type, etag=etag, object_type=object_type)
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    assert response.json()["url"] == bucket.public_url(key)
    assert repo.rows[uuid.UUID(upload_id)].content_md5 is None


async def seed_earlier(bucket: FakeBucket, repo: InMemoryUploadRepository) -> MediaUpload:
    first = uuid.uuid4()
    key = f"iclip/agent/uploads/{first}.mp4"
    bucket.put(key, content_type="video/mp4", size_bytes=70, etag=MD5_ETAG)
    return await repo.insert(
        MediaUpload(
            id=first,
            owner_user_id=uuid.uuid4(),
            api_key_id=None,
            conversation_id=None,
            kind="video",
            url=bucket.public_url(key),
            content_type="video/mp4",
            size_bytes=70,
            duration_ms=30_000,
            width=1080,
            height=1920,
            content_md5=MD5_ETAG.lower(),
            created_at=datetime.now(UTC),
        )
    )


async def test_a_duplicate_hands_back_the_earlier_address_and_drops_this_copy() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    earlier = await seed_earlier(bucket, repo)
    me = uuid.uuid4()
    app = build_test_app(bucket, granted=uploader(me), repo=repo)
    async with client(app) as http:
        upload_id = (await sign(http, "video/quicktime")).json()["uploadId"]
        key = f"iclip/agent/uploads/{upload_id}.mov"
        bucket.put(key, content_type="video/quicktime", size_bytes=70, etag=MD5_ETAG)
        response = await confirm(http, upload_id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["id"], body["url"], body["contentType"], body["sizeBytes"]) == (
        upload_id,
        earlier.url,
        "video/mp4",
        70,
    )
    assert key not in bucket.objects, "本次的对象删掉了"
    assert f"iclip/agent/uploads/{earlier.id}.mp4" in bucket.objects
    mine = repo.rows[uuid.UUID(upload_id)]
    assert (mine.owner_user_id, mine.url, mine.content_md5) == (
        me,
        earlier.url,
        earlier.content_md5,
    )


class LateRepository(InMemoryUploadRepository):
    """第一次按 id 读时还没看到那条：同一个 uploadId 的另一次确认正好在这之后记下了它。"""

    def __init__(self) -> None:
        super().__init__()
        self.missed = False

    async def get(self, upload_id: uuid.UUID) -> MediaUpload | None:
        if not self.missed:
            self.missed = True
            return None
        return await super().get(upload_id)


async def test_a_concurrent_confirm_of_the_same_video_keeps_its_object() -> None:
    bucket, repo = FakeBucket(), LateRepository()
    me = uploader()
    upload_id = uuid.uuid4()
    key = f"iclip/agent/uploads/{upload_id}.mp4"
    bucket.put(key, content_type="video/mp4", etag=MD5_ETAG)
    first = await repo.insert(
        MediaUpload(
            id=upload_id,
            owner_user_id=me.user_id,
            api_key_id=None,
            conversation_id=None,
            kind="video",
            url=bucket.public_url(key),
            content_type="video/mp4",
            size_bytes=1024,
            duration_ms=None,
            width=None,
            height=None,
            content_md5=MD5_ETAG.lower(),
            created_at=datetime.now(UTC),
        )
    )

    confirmed = await upload_service(bucket, repo).confirm(me, upload_id)

    assert confirmed == first
    assert key in bucket.objects, "找到的是自己，不当重复的那份删掉"


async def test_a_copy_that_cannot_be_dropped_still_confirms_and_leaves_a_warning() -> None:
    bucket, repo = FakeBucket(), InMemoryUploadRepository()
    bucket.delete_fails = True
    earlier = await seed_earlier(bucket, repo)
    app = build_test_app(bucket, granted=uploader(), repo=repo)
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


EXTERNAL = "https://img.example.com/look.jpg?token=abc"


def picture(width: int = 1200, height: int = 1600, fmt: str = "PNG") -> bytes:
    out = BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format=fmt)
    return out.getvalue()


def importer(
    fetch: FakeFetch, *, bucket: FakeBucket | None = None
) -> tuple[UploadService, FakeBucket, InMemoryUploadRepository]:
    bucket = bucket or FakeBucket()
    repo = InMemoryUploadRepository()
    return upload_service(bucket, repo, fetch=fetch), bucket, repo


async def test_an_imported_image_is_stored_with_audit_metadata_and_recorded_as_an_upload() -> None:
    me, key_id, upload_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    fetch = FakeFetch(body=picture())
    service, bucket, repo = importer(fetch)
    principal = uploader(me, api_key_id=key_id)

    url = await service.import_image(principal, EXTERNAL, upload_id=upload_id)

    object_key = f"iclip/agent/uploads/{upload_id}.png"
    assert url == f"https://cdn.test/{object_key}"
    assert fetch.calls == [(EXTERNAL, MAX_BYTES["image"])]
    assert bucket.objects[object_key].content_type == "image/png"
    assert bucket.written[object_key] == (
        picture(),
        {UPLOADER_HEADER: str(me), API_KEY_HEADER: str(key_id)},
    )
    stored = repo.rows[upload_id]
    assert (
        stored.owner_user_id,
        stored.api_key_id,
        stored.conversation_id,
        stored.kind,
        stored.url,
        stored.content_type,
        stored.size_bytes,
        stored.width,
        stored.height,
        stored.duration_ms,
    ) == (me, key_id, None, "image", url, "image/png", len(picture()), 1200, 1600, None)


async def test_a_multi_picture_jpeg_from_a_phone_is_stored_as_jpg() -> None:
    upload_id = uuid.uuid4()
    service, bucket, repo = importer(FakeFetch(body=multi_picture_jpeg()))

    url = await service.import_image(uploader(), EXTERNAL, upload_id=upload_id)

    object_key = f"iclip/agent/uploads/{upload_id}.jpg"
    assert url == f"https://cdn.test/{object_key}"
    assert bucket.objects[object_key].content_type == "image/jpeg"
    assert (repo.rows[upload_id].kind, repo.rows[upload_id].content_type) == (
        "image",
        "image/jpeg",
    )


async def test_an_upload_already_recorded_is_handed_back_without_downloading() -> None:
    upload_id = uuid.uuid4()
    fetch = FakeFetch(body=picture())
    service, bucket, repo = importer(fetch)
    await service.import_image(uploader(), EXTERNAL, upload_id=upload_id)
    first_url = repo.rows[upload_id].url
    fetch.calls.clear()
    bucket.written.clear()

    url = await service.import_image(uploader(), EXTERNAL, upload_id=upload_id)

    assert url == first_url
    assert fetch.calls == []
    assert bucket.written == {}
    assert list(repo.rows) == [upload_id]


@pytest.mark.parametrize(
    ("fetch", "reason"),
    [
        pytest.param(FakeFetch(body=b"<html>not found</html>"), "不是能读的图片", id="不是图片"),
        pytest.param(FakeFetch(body=picture(fmt="GIF")), "image/gif", id="不收的格式"),
        pytest.param(FakeFetch(body=picture(200, 1200)), "太小了", id="短边不够"),
        pytest.param(FakeFetch(body=picture(800, 6400)), "长边超过", id="长边超了"),
        pytest.param(
            FakeFetch(body=b"x" * (MAX_BYTES["image"] + 1)), "超过 16MB", id="下载器没截住的大文件"
        ),
        pytest.param(
            FakeFetch(error=FetchFailed("对方回了 404")), "下载不下来：对方回了 404", id="下载失败"
        ),
        pytest.param(
            FakeFetch(error=FetchFailed("img.example.com 解析到了非公网地址 10.0.0.1")),
            "下载不下来：img.example.com 解析到了非公网地址",
            id="出网规则拒绝",
        ),
        pytest.param(FakeFetch(error=FetchTooLarge("太大")), "超过 16MB", id="超过大小"),
    ],
)
async def test_an_image_that_does_not_pass_is_refused_and_nothing_is_kept(
    fetch: FakeFetch, reason: str
) -> None:
    service, bucket, repo = importer(fetch)

    with pytest.raises(ValidationFailed, match=reason):
        await service.import_image(uploader(), EXTERNAL, upload_id=uuid.uuid4())

    assert bucket.written == {}
    assert repo.rows == {}


async def test_a_bucket_write_failure_stays_an_object_store_error() -> None:
    bucket = FakeBucket()
    bucket.put_fails = True
    service, _, repo = importer(FakeFetch(body=picture()), bucket=bucket)

    with pytest.raises(ObjectStoreUnavailable):
        await service.import_image(uploader(), EXTERNAL, upload_id=uuid.uuid4())

    assert repo.rows == {}
