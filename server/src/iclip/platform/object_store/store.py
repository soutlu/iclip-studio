from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

SIGNED_PUT_EXPIRES_SECONDS = 3600


@dataclass(frozen=True, slots=True)
class StoredObject:
    object_key: str
    content_type: str
    size_bytes: int
    etag: str | None = None
    object_type: str | None = None


class ObjectStoreUnavailable(Exception):
    pass


class PublicObjectStore(Protocol):
    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str: ...


class SignedUploadStore(Protocol):
    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str: ...

    async def find_object(self, *, prefix: str) -> StoredObject | None: ...

    async def delete_object(self, object_key: str) -> None: ...

    def public_url(self, object_key: str) -> str: ...


class PublicBucket(PublicObjectStore, SignedUploadStore, Protocol):
    pass


@dataclass(frozen=True, slots=True)
class SignedUpload:
    url: str
    headers: Mapping[str, str]


class ServerUploadSigner(Protocol):
    def sign_server_upload(
        self, *, object_key: str, content_type: str, expires_seconds: int
    ) -> SignedUpload: ...


__all__ = [
    "SIGNED_PUT_EXPIRES_SECONDS",
    "ObjectStoreUnavailable",
    "PublicBucket",
    "PublicObjectStore",
    "ServerUploadSigner",
    "SignedUpload",
    "SignedUploadStore",
    "StoredObject",
]
