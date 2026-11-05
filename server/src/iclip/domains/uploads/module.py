from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.identity.public import ActAs
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.service import (
    ConversationWritable,
    FetchBytes,
    FindRecordedUpload,
    RecordUpload,
    UploadService,
)
from iclip.platform.object_store.store import PublicBucket


@dataclass(frozen=True)
class UploadsModule:
    routers: tuple[Any, ...]

    service: UploadService


def build_uploads_module(
    objects: PublicBucket,
    *,
    act_as: ActAs,
    record: RecordUpload,
    find_recorded: FindRecordedUpload,
    fetch: FetchBytes,
    conversation_writable: ConversationWritable,
) -> UploadsModule:
    service = UploadService(
        objects,
        record=record,
        find_recorded=find_recorded,
        fetch=fetch,
        conversation_writable=conversation_writable,
    )
    return UploadsModule(routers=(create_uploads_router(service, act_as=act_as),), service=service)


__all__ = ["UploadsModule", "build_uploads_module"]
