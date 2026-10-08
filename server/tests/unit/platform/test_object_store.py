"""使用 bucket 替身验证公开对象存储适配器的 key 边界、URL、重试与直传签名，以及内网 endpoint 的
校验、读写与签名的分工和下载地址换算。"""

from __future__ import annotations

from dataclasses import replace
from urllib.parse import urlsplit

import oss2
import pytest

import iclip.platform.object_store.oss as oss_module
from iclip.platform.object_store.layout import OSS_ROOT
from iclip.platform.object_store.oss import (
    RETRY_ATTEMPTS,
    OssObjectStore,
    OssSettings,
    oss_fetch_url,
    validate_internal_endpoint,
    validate_public_url_base,
)
from iclip.platform.object_store.store import ObjectStoreUnavailable

SETTINGS = OssSettings(
    bucket="iclip",
    endpoint="https://oss.test",
    access_key_id="ak",
    access_key_secret="sk",
    public_url_base="https://cdn.test/",
)

KEY = f"{OSS_ROOT}/generated-images/a.png"


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """移除重试等待，仅验证次数和错误分类。"""

    monkeypatch.setattr(oss_module, "RETRY_BACKOFF_SECONDS", 0.0)


def timeout() -> oss2.exceptions.RequestError:
    """模拟 SDK 封装的 requests 读取超时，status 为 -2。"""

    return oss2.exceptions.RequestError(OSError("Read timed out. (read timeout=60)"))


def server_error(status: int) -> oss2.exceptions.ServerError:
    return oss2.exceptions.ServerError(status, {}, b"", {})


class FakeObjectInfo:
    def __init__(self, key: str) -> None:
        self.key = key


class FakeListing:
    def __init__(self, keys: list[str]) -> None:
        self.object_list = [FakeObjectInfo(key) for key in keys]


class FakeHead:
    """SDK 的 HeadObjectResult：ETag 已去掉引号，缺的头为 None。"""

    def __init__(
        self,
        *,
        content_type: str,
        content_length: int,
        etag: str | None = None,
        object_type: str | None = None,
    ) -> None:
        self.content_type = content_type
        self.content_length = content_length
        self.etag = etag
        self.object_type = object_type


class FakeBucket:
    def __init__(
        self,
        *,
        existing: set[str] | None = None,
        failures: list[Exception] | None = None,
        listed: list[str] | None = None,
        head: FakeHead | None = None,
    ) -> None:
        self.existing = existing or set()
        self.failures = list(failures or [])
        """按序为请求注入异常；耗尽后正常响应，剩余项可检测请求次数。"""
        self.listed = listed or []
        self.head = head
        self.writes: list[tuple[str, bytes, str]] = []
        self.signed: list[tuple[str, str, int, dict[str, str], bool]] = []
        self.deleted: list[str] = []

    def _answer(self) -> None:
        if self.failures:
            raise self.failures.pop(0)

    def object_exists(self, object_key: str) -> bool:
        self._answer()
        return object_key in self.existing

    def put_object(self, object_key: str, content: bytes, headers: dict[str, str]) -> None:
        self.writes.append((object_key, content, headers["Content-Type"]))

    def sign_url(
        self,
        method: str,
        key: str,
        expires: int,
        headers: dict[str, str] | None = None,
        slash_safe: bool = False,
    ) -> str:
        self.signed.append((method, key, expires, headers or {}, slash_safe))
        return f"https://oss.test/{key}?signed"

    def list_objects(self, prefix: str, max_keys: int) -> FakeListing:
        self._answer()
        return FakeListing([key for key in self.listed if key.startswith(prefix)][:max_keys])

    def head_object(self, key: str) -> FakeHead:
        assert self.head is not None
        return self.head

    def delete_object(self, key: str) -> None:
        self._answer()
        self.existing.discard(key)
        self.deleted.append(key)


def store(bucket: FakeBucket) -> OssObjectStore:
    return OssObjectStore(SETTINGS, bucket=bucket)


async def test_write_returns_public_url_and_encodes_the_key() -> None:
    bucket = FakeBucket()
    key = f"{OSS_ROOT}/generated-images/a b.png"
    url = await store(bucket).put_public_object(
        object_key=key, content=b"X", content_type="image/png"
    )

    assert url == f"https://cdn.test/{OSS_ROOT}/generated-images/a%20b.png"
    assert bucket.writes == [(key, b"X", "image/png")]


async def test_existing_key_is_reused_not_rewritten() -> None:

    bucket = FakeBucket(existing={KEY})
    url = await store(bucket).put_public_object(
        object_key=KEY, content=b"X", content_type="image/png"
    )

    assert url == f"https://cdn.test/{KEY}"
    assert bucket.writes == []


@pytest.mark.parametrize(
    "bad_key",
    [
        "",
        "   ",
        "/",
        f"{OSS_ROOT}/a//b",
        f"{OSS_ROOT}/../secrets/x.png",
        f"{OSS_ROOT}/a/./b.png",
    ],
)
async def test_keys_that_could_escape_the_prefix_are_rejected(bad_key: str) -> None:
    bucket = FakeBucket()
    with pytest.raises(ValueError):
        await store(bucket).put_public_object(
            object_key=bad_key, content=b"X", content_type="image/png"
        )
    assert bucket.writes == []


@pytest.mark.parametrize("outside", ["generated-images/a.png", "iclip/other/a.png", "a.png"])
async def test_keys_outside_our_namespace_are_rejected(outside: str) -> None:

    bucket = FakeBucket()
    with pytest.raises(ValueError, match=OSS_ROOT):
        await store(bucket).put_public_object(
            object_key=outside, content=b"X", content_type="image/png"
        )
    assert bucket.writes == []


async def test_empty_content_is_rejected() -> None:
    with pytest.raises(ValueError, match="不能为空"):
        await store(FakeBucket()).put_public_object(
            object_key=KEY, content=b"", content_type="image/png"
        )


async def test_a_network_blip_is_retried_and_the_write_still_lands() -> None:

    bucket = FakeBucket(failures=[timeout()])
    url = await store(bucket).put_public_object(
        object_key=KEY, content=b"X", content_type="image/png"
    )

    assert url == f"https://cdn.test/{KEY}"
    assert bucket.writes == [(KEY, b"X", "image/png")]


async def test_a_server_side_5xx_is_retried_too() -> None:
    bucket = FakeBucket(failures=[server_error(503)])
    await store(bucket).put_public_object(object_key=KEY, content=b"X", content_type="image/png")

    assert len(bucket.writes) == 1


async def test_sdk_failure_becomes_one_known_error_once_the_attempts_run_out() -> None:
    """统一 SDK 异常类型并保留尝试次数，供业务层处理和日志诊断。"""

    bucket = FakeBucket(failures=[timeout() for _ in range(RETRY_ATTEMPTS + 1)])
    with pytest.raises(ObjectStoreUnavailable, match=f"试了 {RETRY_ATTEMPTS} 次"):
        await store(bucket).put_public_object(
            object_key=KEY, content=b"X", content_type="image/png"
        )

    assert len(bucket.failures) == 1
    assert bucket.writes == []


async def test_client_side_rejections_are_not_retried() -> None:
    """403 等客户端错误无法通过重试恢复，应立即返回。"""

    bucket = FakeBucket(failures=[server_error(403), server_error(403)])
    with pytest.raises(ObjectStoreUnavailable) as failure:
        await store(bucket).put_public_object(
            object_key=KEY, content=b"X", content_type="image/png"
        )

    assert "试了" not in str(failure.value)
    assert len(bucket.failures) == 1
    assert bucket.writes == []


async def test_find_object_survives_a_network_blip() -> None:
    bucket = FakeBucket(
        failures=[timeout()],
        listed=[KEY],
        head=FakeHead(content_type="image/png", content_length=7),
    )

    found = await store(bucket).find_object(prefix=f"{OSS_ROOT}/generated-images/a.")

    assert found is not None
    assert found.object_key == KEY


def test_signed_put_binds_every_header_and_keeps_slashes() -> None:
    """Content-Type 与审计头都必须原样参与签名；key 中的斜杠须保留，避免上传为含 %2F 的其他对象。"""

    bucket = FakeBucket()
    wanted = {"Content-Type": "image/png", "x-oss-meta-uploader": "3c1e"}
    url = store(bucket).sign_put(object_key=KEY, headers=wanted)

    assert url.endswith("?signed")
    method, key, expires, headers, slash_safe = bucket.signed[0]
    assert (method, key) == ("PUT", KEY)
    assert headers == wanted
    assert slash_safe is True
    assert expires > 0


def test_signed_put_refuses_keys_outside_the_namespace() -> None:
    bucket = FakeBucket()
    with pytest.raises(ValueError, match=OSS_ROOT):
        store(bucket).sign_put(object_key="uploads/a.png", headers={"Content-Type": "image/png"})
    assert bucket.signed == []


def test_signed_put_refuses_a_blank_content_type() -> None:
    bucket = FakeBucket()
    with pytest.raises(ValueError, match="内容类型"):
        store(bucket).sign_put(object_key=KEY, headers={"Content-Type": " "})
    assert bucket.signed == []


async def test_find_object_reports_what_the_bucket_says() -> None:

    bucket = FakeBucket(
        listed=[KEY],
        head=FakeHead(
            content_type="image/png",
            content_length=7,
            etag="0123456789ABCDEF0123456789ABCDEF",
            object_type="Normal",
        ),
    )

    found = await store(bucket).find_object(prefix=f"{OSS_ROOT}/generated-images/a.")

    assert found is not None
    assert (
        found.object_key,
        found.content_type,
        found.size_bytes,
        found.etag,
        found.object_type,
    ) == (KEY, "image/png", 7, "0123456789ABCDEF0123456789ABCDEF", "Normal")


async def test_delete_survives_a_network_blip() -> None:
    bucket = FakeBucket(existing={KEY}, failures=[timeout()])

    await store(bucket).delete_object(KEY)

    assert bucket.deleted == [KEY]


async def test_a_refused_delete_becomes_the_known_error_without_retrying() -> None:
    bucket = FakeBucket(existing={KEY}, failures=[server_error(403), server_error(403)])

    with pytest.raises(ObjectStoreUnavailable, match="删除"):
        await store(bucket).delete_object(KEY)

    assert len(bucket.failures) == 1
    assert bucket.deleted == []


async def test_delete_refuses_keys_outside_the_namespace() -> None:
    bucket = FakeBucket()

    with pytest.raises(ValueError, match=OSS_ROOT):
        await store(bucket).delete_object("uploads/a.mp4")

    assert bucket.deleted == []


async def test_find_object_returns_none_when_nothing_was_uploaded() -> None:
    found = await store(FakeBucket()).find_object(prefix=f"{OSS_ROOT}/uploads/x.")

    assert found is None


async def test_find_object_refuses_an_ambiguous_prefix() -> None:

    bucket = FakeBucket(
        listed=[f"{OSS_ROOT}/uploads/x.png", f"{OSS_ROOT}/uploads/x.mp4"],
        head=FakeHead(content_type="image/png", content_length=1),
    )

    with pytest.raises(ObjectStoreUnavailable):
        await store(bucket).find_object(prefix=f"{OSS_ROOT}/uploads/x.")


@pytest.mark.parametrize("bad_base", ["", "cdn.test", "ftp://cdn.test", "   "])
def test_public_url_base_must_be_http(bad_base: str) -> None:

    with pytest.raises(ValueError):
        validate_public_url_base(bad_base)


def test_public_url_base_trailing_slash_is_trimmed() -> None:
    assert validate_public_url_base("https://cdn.test/") == "https://cdn.test"


# --- 内网 endpoint ---------------------------------------------------------------

INTERNAL = replace(SETTINGS, internal_endpoint="https://oss-cn-shenzhen-internal.aliyuncs.com")


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_blank_internal_endpoint_means_none(blank: str) -> None:
    assert validate_internal_endpoint(blank) is None


def test_an_internal_endpoint_is_kept_without_its_trailing_slash() -> None:
    assert (
        validate_internal_endpoint(" https://oss-cn-shenzhen-internal.aliyuncs.com/ ")
        == "https://oss-cn-shenzhen-internal.aliyuncs.com"
    )


@pytest.mark.parametrize(
    "bad",
    [
        "oss-cn-shenzhen-internal.aliyuncs.com",
        "ftp://oss-cn-shenzhen-internal.aliyuncs.com",
        "https://",
        "https://oss-cn-shenzhen-internal.aliyuncs.com/iclip",
        "https://oss-cn-shenzhen-internal.aliyuncs.com?x=1",
    ],
)
def test_an_internal_endpoint_must_be_a_bare_http_origin(bad: str) -> None:
    with pytest.raises(ValueError, match="OSS_INTERNAL_ENDPOINT"):
        validate_internal_endpoint(bad)


def test_own_bucket_addresses_are_rewritten_to_the_internal_host() -> None:
    fetch_url = oss_fetch_url(INTERNAL)

    assert fetch_url(f"https://cdn.test/{KEY}") == (
        f"https://iclip.oss-cn-shenzhen-internal.aliyuncs.com/{KEY}"
    )
    assert fetch_url(f"https://cdn.test/{KEY}?x-oss-process=image/info") == (
        f"https://iclip.oss-cn-shenzhen-internal.aliyuncs.com/{KEY}?x-oss-process=image/info"
    ), "查询串原样保留"


@pytest.mark.parametrize(
    "other",
    [
        "https://vendor.test/result.mp4",
        "https://image-gateway.test/tmp/a.png?Expires=1&Signature=abc",
        "https://cdn.test.evil/iclip/agent/a.png",
        "https://cdn.test",
    ],
)
def test_other_addresses_are_left_alone(other: str) -> None:
    assert oss_fetch_url(INTERNAL)(other) == other


def test_without_an_internal_endpoint_nothing_is_rewritten() -> None:
    assert oss_fetch_url(SETTINGS)(f"https://cdn.test/{KEY}") == f"https://cdn.test/{KEY}"


async def test_reads_writes_and_deletes_go_to_the_data_bucket_and_signing_to_the_other() -> None:
    data = FakeBucket(listed=[KEY], head=FakeHead(content_type="image/png", content_length=1))
    signing = FakeBucket()
    store = OssObjectStore(INTERNAL, bucket=data, signing_bucket=signing)

    await store.put_public_object(object_key=KEY, content=b"X", content_type="image/png")
    found = await store.find_object(prefix=f"{OSS_ROOT}/generated-images/a.")
    await store.delete_object(KEY)
    store.sign_put(object_key=KEY, headers={"Content-Type": "image/png"})

    assert found is not None and found.object_key == KEY, "列举与元信息问的是读写客户端"
    assert (data.writes, data.deleted, data.signed) == ([(KEY, b"X", "image/png")], [KEY], [])
    assert (signing.writes, signing.deleted) == ([], [])
    assert [(method, key) for method, key, *_ in signing.signed] == [("PUT", KEY)]


def test_signed_put_uses_the_public_endpoint_even_with_an_internal_one() -> None:
    """签名在本地算，不发请求；浏览器拿到的直传地址必须是公网 host。"""

    settings = replace(INTERNAL, endpoint="https://oss-cn-shenzhen.aliyuncs.com")
    url = OssObjectStore(settings).sign_put(object_key=KEY, headers={"Content-Type": "image/png"})

    assert urlsplit(url).netloc == "iclip.oss-cn-shenzhen.aliyuncs.com"
