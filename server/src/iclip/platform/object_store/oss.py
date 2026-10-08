"""OSS 公开对象适配器：实现 store.py 的端口，负责稳定 key 写入、直传签名、重试和异常映射。

同步网络调用在线程中执行；供应商生成结果转存后避免依赖临时签名 URL。配了内网 endpoint 时，服务端
读写走内网，浏览器直传的签名仍用公网 endpoint；``oss_fetch_url`` 给服务端下载本桶对象换内网地址。
"""

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
    StoredObject,
)

RETRY_ATTEMPTS = 3
"""网络错误与 5xx 的最大尝试次数；4xx 不重试。"""

RETRY_BACKOFF_SECONDS = 1.0
"""重试基础间隔，按尝试次数线性增加。"""


@dataclass(frozen=True, slots=True)
class OssSettings:
    """OSS 的运行值，由组合根从环境变量解析后传入。"""

    bucket: str
    endpoint: str
    access_key_id: str
    access_key_secret: str
    public_url_base: str
    """公网访问前缀（自定义域名或 bucket 默认域名），不带尾斜杠。"""

    internal_endpoint: str | None = None
    """同地域内网 endpoint（经 ``validate_internal_endpoint``）；None 表示服务端也走 ``endpoint``。"""


class OssObjectStore:
    """``PublicBucket`` 的 OSS 实现。

    写入、存在性检查、列举、元信息与删除用读写客户端：配了内网 endpoint 时连内网，否则连
    ``endpoint``；直传签名用签名客户端，始终按 ``endpoint`` 拼地址，浏览器才连得上。两个客户端
    共用一份凭证。"""

    def __init__(
        self,
        settings: OssSettings,
        *,
        bucket: Any | None = None,
        signing_bucket: Any | None = None,
    ) -> None:
        """``bucket`` 替换读写客户端，``signing_bucket`` 替换签名客户端（测试替身）。只注入
        ``bucket`` 时签名也用它；未注入的按 ``settings`` 创建。"""

        self._public_url_base = settings.public_url_base.rstrip("/")
        auth = oss2.Auth(settings.access_key_id, settings.access_key_secret)
        # OSS SDK 无类型标注，边界处显式使用 Any。
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

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """在线程中执行同步 OSS 上传，避免阻塞事件循环。"""

        key = _validate_object_key(object_key)
        if not content:
            raise ValueError("对象内容不能为空")
        await asyncio.to_thread(self._put, key, content, content_type)
        return self.public_url(key)

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        """本地计算限时 PUT 签名，不发送网络请求。"""

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
                    # 保留 key 中的斜杠，避免编码后上传到其他对象名。
                    slash_safe=True,
                )
            )
        except oss2.exceptions.OssError as exc:  # pragma: no cover - 本地计算，理论上不会走到
            raise ObjectStoreUnavailable(f"OSS 签名失败: {exc}") from exc

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """在线程中执行对象列举及元信息查询。"""

        return await asyncio.to_thread(self._find, _validate_object_key(prefix))

    async def delete_object(self, object_key: str) -> None:
        """在线程中执行删除；OSS 删除不存在的对象也返回成功，重试不会因为上一次已删而报错。"""

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
            # SDK 已去掉 ETag 两边的引号；缺这两个头时为 None。
            etag=head.etag,
            object_type=head.object_type,
        )

    def _put(self, object_key: str, content: bytes, content_type: str) -> None:
        """已存在 key 直接复用；存在性检查与写入整体重试。

        稳定 key 对应确定内容，并发写入相同 key 不改变结果；响应超时后可通过检查避免重传。
        """

        def once() -> None:
            if self._bucket.object_exists(object_key):
                return
            self._bucket.put_object(object_key, content, headers={"Content-Type": content_type})

        _with_retries(once, what="写入")


def _with_retries[T](action: Callable[[], T], *, what: str) -> T:
    """执行同步调用；仅重试网络错误与 5xx，其他异常立即转换。"""

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
    """校验 key 的路径与命名空间，避免写入共享桶中本服务范围之外。"""

    key = object_key.strip().strip("/")
    if not key:
        raise ValueError("对象 key 不能为空")
    if any(segment in {"", ".", ".."} for segment in key.split("/")):
        raise ValueError("对象 key 不能包含空段或 . / ..")
    if not key.startswith(f"{OSS_ROOT}/"):
        raise ValueError(f"对象 key 必须落在 {OSS_ROOT}/ 下面: {key}")
    return key


def validate_public_url_base(value: str) -> str:
    """启动时校验公网 URL 前缀。"""

    base = value.strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("对象存储的公网访问前缀必须是 http:// 或 https:// 地址")
    return base


def validate_internal_endpoint(value: str) -> str | None:
    """启动时校验内网 endpoint：留空返回 None（不走内网）；否则必须是只有 scheme 与 host 的
    http:// 或 https:// 地址，带路径或查询串即拒，因为下载地址按 ``{scheme}://{bucket}.{host}/`` 拼。"""

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
    """本服务下载本桶对象前用的地址换算，不发网络请求。

    以 ``public_url_base`` 加 ``/`` 开头的地址换成 ``{内网 scheme}://{bucket}.{内网 host}/`` 加原来
    剩下的部分（key 与查询串原样）；其余地址（供应商、图片网关等）原样返回。没配内网 endpoint 时
    一律原样返回。只在发起下载的那一刻换，落库、回给前端或交给外部服务的地址不经过它。"""

    internal = settings.internal_endpoint
    if internal is None:
        return _as_is
    parts = urlsplit(internal)
    public_prefix = f"{settings.public_url_base.rstrip('/')}/"
    internal_prefix = f"{parts.scheme}://{settings.bucket}.{parts.netloc}/"

    def fetch_url(url: str) -> str:
        if url.startswith(public_prefix):
            return internal_prefix + url[len(public_prefix) :]
        return url

    return fetch_url


def _as_is(url: str) -> str:
    return url


__all__ = [
    "RETRY_ATTEMPTS",
    "RETRY_BACKOFF_SECONDS",
    "OssObjectStore",
    "OssSettings",
    "oss_fetch_url",
    "validate_internal_endpoint",
    "validate_public_url_base",
]
