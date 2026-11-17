from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.identity.public import ActAs
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.repository import UploadRepository
from iclip.domains.uploads.service import (
    ConversationWritable,
    FetchBytes,
    UploadLineage,
    UploadService,
)
from iclip.platform.object_store.store import PublicBucket


@dataclass(frozen=True)
class UploadsModule:
    routers: tuple[Any, ...]

    service: UploadService


def build_uploads_module(
    objects: PublicBucket,
    repo: UploadRepository,
    *,
    act_as: ActAs,
    fetch: FetchBytes,
    conversation_writable: ConversationWritable,
    lineage: UploadLineage,
) -> UploadsModule:
    service = UploadService(
        objects,
        repo,
        fetch=fetch,
        conversation_writable=conversation_writable,
        lineage=lineage,
    )
    return UploadsModule(routers=(create_uploads_router(service, act_as=act_as),), service=service)


__all__ = ["UploadsModule", "build_uploads_module"]
