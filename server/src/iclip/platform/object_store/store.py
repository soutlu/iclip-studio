"""公开对象存储的端口协议、对象元信息与错误类型；不依赖任何存储 SDK。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

SIGNED_PUT_EXPIRES_SECONDS = 3600
"""预签名 PUT 有效期，包含用户准备与大文件上传所需时间。"""


@dataclass(frozen=True, slots=True)
class StoredObject:
    """从桶读取的对象元信息，确认上传时的事实来源。"""

    object_key: str
    content_type: str
    size_bytes: int
    etag: str | None = None
    """存储给的 ETag，不带引号；一次整传的对象（``object_type`` 为 ``Normal``）就是内容的 MD5。"""
    object_type: str | None = None
    """存储给的对象类型：``Normal`` 是一次整传，分片与追加上传的 ETag 不是 MD5。"""


class ObjectStoreUnavailable(Exception):
    """对象存储调用失败；由调用边界转换，不归入领域 HTTP 错误。"""


class PublicObjectStore(Protocol):
    """公开对象写入端口，供无需直传能力的调用方依赖。"""

    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str:
        """写入公开对象，返回它的公网 URL；同 key 已存在即复用。

        ``metadata`` 是随对象存进桶的 ``x-oss-meta-*`` 头（键写全名，值只能是 ASCII），审计用；
        同 key 已存在时不改原有的。"""
        ...


class SignedUploadStore(Protocol):
    """浏览器直传所需的签名、对象查询和 URL 构造端口。"""

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        """生成限时 PUT URL，有效期为 ``SIGNED_PUT_EXPIRES_SECONDS``。``headers`` 全部签进去：
        Content-Type 限制上传类型，``x-oss-meta-*`` 记审计；客户端必须原样带上。"""
        ...

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        """按前缀查询唯一对象；不存在返回 None，多个匹配视为错误。"""
        ...

    async def delete_object(self, object_key: str) -> None:
        """删除这个对象；对象本来就不在也算删掉。失败抛 ``ObjectStoreUnavailable``。"""
        ...

    def public_url(self, object_key: str) -> str:
        """从 key 生成公网地址，支持更换域名而无需迁移持久化记录。"""
        ...


class PublicBucket(PublicObjectStore, SignedUploadStore, Protocol):
    """完整公开桶端口；消费者可依赖所需的较小接口。"""


@dataclass(frozen=True, slots=True)
class SignedPrivatePut:
    """服务端之间传私有对象用的限时 PUT：往 ``url`` 发 PUT，``headers`` 原样带上（都签进了签名）。"""

    url: str
    headers: Mapping[str, str]
    expires_at: datetime


class PrivateObjectSigner(Protocol):
    """私有临时对象的签名端口：本地计算，不发网络请求。"""

    def sign_private_put(
        self, *, object_key: str, content_type: str, expires_seconds: int
    ) -> SignedPrivatePut:
        """签一个限时 PUT，上传的对象是私有读。签名覆盖 ``Content-Type`` 与
        ``x-oss-object-acl: private``；地址给服务端用（配了内网 endpoint 就是内网地址）。"""
        ...

    def sign_download(self, *, object_key: str, filename: str, expires_seconds: int) -> str:
        """签一个限时 GET，给浏览器下载：地址走公网 endpoint，响应按附件下载、文件名是
        ``filename``（可以是中文）。"""
        ...


__all__ = [
    "SIGNED_PUT_EXPIRES_SECONDS",
    "ObjectStoreUnavailable",
    "PrivateObjectSigner",
    "PublicBucket",
    "PublicObjectStore",
    "SignedPrivatePut",
    "SignedUploadStore",
    "StoredObject",
]
