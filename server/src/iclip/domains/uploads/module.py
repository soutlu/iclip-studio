"""uploads 装配单元：组合根只调用 ``build_uploads_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.identity.public import ActAs
from iclip.domains.uploads.api import create_uploads_router
from iclip.domains.uploads.service import (
    FetchBytes,
    FindRecordedUpload,
    RecordUpload,
    UploadService,
)
from iclip.platform.object_store.store import PublicBucket


@dataclass(frozen=True)
class UploadsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: UploadService


def build_uploads_module(
    objects: PublicBucket,
    *,
    act_as: ActAs,
    record: RecordUpload,
    find_recorded: FindRecordedUpload,
    fetch: FetchBytes,
) -> UploadsModule:
    """``record`` 把确认过的上传记成一条记录，``find_recorded`` 查这次上传记过没有；两者都由
    组合根接到生成域。``fetch`` 是转存图片用的出网下载，组合根接到出网下载器。"""

    service = UploadService(objects, record=record, find_recorded=find_recorded, fetch=fetch)
    return UploadsModule(routers=(create_uploads_router(service, act_as=act_as),), service=service)


__all__ = ["UploadsModule", "build_uploads_module"]
