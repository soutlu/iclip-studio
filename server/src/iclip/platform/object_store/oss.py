from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

import oss2

from iclip.platform.object_store.layout import OSS_ROOT
from iclip.platform.object_store.store import (
    SIGNED_PUT_EXPIRES_SECONDS,
    ObjectStoreUnavailable,
    SignedUpload,
    StoredObject,
)

RETRY_ATTEMPTS = 3

RETRY_BACKOFF_SECONDS = 1.0


@dataclass(frozen=True, slots=True)
class OssSettings:
    bucket: str
    endpoint: str
    access_key_id: str
    access_key_secret: str
    public_url_base: str

    internal_endpoint: str | None = None


class OssObjectStore:
    def __init__(
        self,
        settings: OssSettings,
        *,
        bucket: Any | None = None,
        signing_bucket: Any | None = None,
    ) -> None:
        self._public_url_base = settings.public_url_base.rstrip("/")
        auth = oss2.Auth(settings.access_key_id, settings.access_key_secret)
        if signing_bucket is None:
            signing_bucket = bucket
        if signing_bucket is None:
            signing_bucket = oss2.Bucket(auth, settings.endpoint, settings.bucket)
        if bucket is None and settings.internal_endpoint is not None:
            bucket = oss2.Bucket(auth, settings.internal_endpoint, settings.bucket)
        if bucket is None:
            bucket = signing_bucket
        self._signing_bucket: Any = signing_bucket
        self._bucket: Any = bucket

    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str:
        key = _validate_object_key(object_key)
        if not content:
            raise ValueError("对象内容不能为空")
        headers = {**(metadata or {}), "Content-Type": content_type}
        await asyncio.to_thread(self._put, key, content, headers)
        return self.public_url(key)

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        key = _validate_object_key(object_key)
        if not headers.get("Content-Type", "").strip():
            raise ValueError("预签名 PUT 必须指定内容类型")
        try:
            return str(
                self._signing_bucket.sign_url(
                    "PUT",
                    key,
                    SIGNED_PUT_EXPIRES_SECONDS,
                    headers=dict(headers),
                    slash_safe=True,
                )
            )
        except oss2.exceptions.OssError as exc:  # pragma: no cover
            raise ObjectStoreUnavailable(f"OSS 签名失败: {exc}") from exc

    def sign_server_upload(
        self, *, object_key: str, content_type: str, expires_seconds: int
    ) -> SignedUpload:
        key = _validate_object_key(object_key)
        if not content_type.strip():
            raise ValueError("预签名 PUT 必须指定内容类型")
        headers = {"Content-Type": content_type}
        try:
            url = self._bucket.sign_url(
                "PUT", key, expires_seconds, headers=dict(headers), slash_safe=True
            )
        except oss2.exceptions.OssError as exc:  # pragma: no cover
            raise ObjectStoreUnavailable(f"OSS 签名失败: {exc}") from exc
        return SignedUpload(url=str(url), headers=headers)

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        return await asyncio.to_thread(self._find, _validate_object_key(prefix))

    async def delete_object(self, object_key: str) -> None:
        key = _validate_object_key(object_key)
        await asyncio.to_thread(_with_retries, lambda: self._bucket.delete_object(key), what="删除")

    def public_url(self, object_key: str) -> str:
        return f"{self._public_url_base}/{quote(object_key, safe='/')}"

    def _find(self, prefix: str) -> StoredObject | None:
        entries = list(
            _with_retries(
                lambda: self._bucket.list_objects(prefix=prefix, max_keys=2).object_list,
                what="读取",
            )
        )
        if not entries:
            return None
        if len(entries) > 1:
            raise ObjectStoreUnavailable(f"前缀 {prefix} 下不止一个对象，无法确定是哪个")
        key = entries[0].key
        head = _with_retries(lambda: self._bucket.head_object(key), what="读取")
        return StoredObject(
            object_key=key,
            content_type=str(head.content_type or "").split(";")[0].strip(),
            size_bytes=int(head.content_length),
            etag=head.etag,
            object_type=head.object_type,
        )

    def _put(self, object_key: str, content: bytes, headers: Mapping[str, str]) -> None:
        def once() -> None:
            if self._bucket.object_exists(object_key):
                return
            self._bucket.put_object(object_key, content, headers=dict(headers))

        _with_retries(once, what="写入")


def _with_retries[T](action: Callable[[], T], *, what: str) -> T:
    attempt = 0
    while True:
        attempt += 1
        try:
            return action()
        except oss2.exceptions.OssError as exc:
            if attempt >= RETRY_ATTEMPTS or not _is_transient(exc):
                tried = f"（试了 {attempt} 次）" if attempt > 1 else ""
                raise ObjectStoreUnavailable(f"OSS {what}失败{tried}: {exc}") from exc
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)


def _is_transient(exc: oss2.exceptions.OssError) -> bool:

    return isinstance(exc, oss2.exceptions.RequestError) or exc.status >= 500


def _validate_object_key(object_key: str) -> str:
    key = object_key.strip().strip("/")
    if not key:
        raise ValueError("对象 key 不能为空")
    if any(segment in {"", ".", ".."} for segment in key.split("/")):
        raise ValueError("对象 key 不能包含空段或 . / ..")
    if not key.startswith(f"{OSS_ROOT}/"):
        raise ValueError(f"对象 key 必须落在 {OSS_ROOT}/ 下面: {key}")
    return key


def validate_public_url_base(value: str) -> str:
    base = value.strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("对象存储的公网访问前缀必须是 http:// 或 https:// 地址")
    return base


def validate_internal_endpoint(value: str) -> str | None:
    endpoint = value.strip().rstrip("/")
    if not endpoint:
        return None
    parts = urlsplit(endpoint)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("OSS_INTERNAL_ENDPOINT 必须是 http:// 或 https:// 地址")
    if parts.path or parts.query or parts.fragment:
        raise ValueError("OSS_INTERNAL_ENDPOINT 只写 scheme 与 host，不带路径或查询串")
    return endpoint


def oss_fetch_url(settings: OssSettings) -> Callable[[str], str]:
    internal = settings.internal_endpoint
    if internal is None:
        return _as_is
    parts = urlsplit(internal)
    public_prefix = _public_prefix(settings)
    internal_prefix = f"{parts.scheme}://{settings.bucket}.{parts.netloc}/"

    def fetch_url(url: str) -> str:
        if url.startswith(public_prefix):
            return internal_prefix + url[len(public_prefix) :]
        return url

    return fetch_url


def oss_owns_url(settings: OssSettings) -> Callable[[str], bool]:
    public_prefix = _public_prefix(settings)

    def owns(url: str) -> bool:
        return url.startswith(public_prefix)

    return owns


def _public_prefix(settings: OssSettings) -> str:
    return f"{settings.public_url_base.rstrip('/')}/"


def _as_is(url: str) -> str:
    return url


__all__ = [
    "RETRY_ATTEMPTS",
    "RETRY_BACKOFF_SECONDS",
    "OssObjectStore",
    "OssSettings",
    "oss_fetch_url",
    "oss_owns_url",
    "validate_internal_endpoint",
    "validate_public_url_base",
]
