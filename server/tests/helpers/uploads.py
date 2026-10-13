"""uploads 测试替身。"""

from __future__ import annotations

from collections.abc import Mapping

from iclip.platform.object_store.store import ObjectStoreUnavailable, StoredObject


class FakeBucket:
    """PublicBucket 内存替身；``put`` 模拟浏览器直传，测试负责填充对象。

    ``delete_fails`` 为真时删除抛 ``ObjectStoreUnavailable``，对象留在桶里；``put_fails`` 为真时
    服务端写对象抛同一个错。服务端写入的字节与元数据按 key 记在 ``written``。"""

    def __init__(self, *, base: str = "https://cdn.test") -> None:
        self.base = base
        self.objects: dict[str, StoredObject] = {}
        self.signed: list[tuple[str, dict[str, str]]] = []
        self.written: dict[str, tuple[bytes, dict[str, str]]] = {}
        self.delete_fails = False
        self.put_fails = False

    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str:
        if self.put_fails:
            raise ObjectStoreUnavailable("OSS 写入失败（试了 3 次）: Read timed out")
        self.put(object_key, content_type=content_type, size_bytes=len(content))
        self.written[object_key] = (content, dict(metadata or {}))
        return self.public_url(object_key)

    def put(
        self,
        object_key: str,
        *,
        content_type: str,
        size_bytes: int = 1024,
        etag: str | None = None,
        object_type: str | None = "Normal",
    ) -> None:
        self.objects[object_key] = StoredObject(
            object_key=object_key,
            content_type=content_type,
            size_bytes=size_bytes,
            etag=etag,
            object_type=object_type,
        )

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        self.signed.append((object_key, dict(headers)))
        return f"{self.base}/{object_key}?signed"

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        for key, stored in self.objects.items():
            if key.startswith(prefix):
                return stored
        return None

    async def delete_object(self, object_key: str) -> None:
        if self.delete_fails:
            raise ObjectStoreUnavailable("OSS 删除失败: 403 AccessDenied")
        self.objects.pop(object_key, None)

    def public_url(self, object_key: str) -> str:
        return f"{self.base}/{object_key}"


__all__ = ["FakeBucket"]
