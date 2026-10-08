"""uploads 测试替身。"""

from __future__ import annotations

from collections.abc import Mapping

from iclip.platform.object_store.store import ObjectStoreUnavailable, StoredObject


class FakeBucket:
    """SignedUploadStore 内存替身；``put`` 模拟浏览器直传，测试负责填充对象。

    ``delete_fails`` 为真时删除抛 ``ObjectStoreUnavailable``，对象留在桶里。"""

    def __init__(self, *, base: str = "https://cdn.test") -> None:
        self.base = base
        self.objects: dict[str, StoredObject] = {}
        self.signed: list[tuple[str, dict[str, str]]] = []
        self.delete_fails = False

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
