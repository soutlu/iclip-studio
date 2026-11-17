from __future__ import annotations

from iclip.domains.identity.public import Principal
from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.uploads.service import UploadService


class UsableReferenceClips:
    """局部编辑的参考片段认哪些地址：调用者本人的一条视频上传，或资料库里一条没移除的参考视频。"""

    def __init__(self, uploads: UploadService, references: SqlReferenceStore) -> None:
        self._uploads = uploads
        self._references = references

    async def __call__(self, principal: Principal, url: str) -> bool:
        if await self._uploads.owns_video_at(principal, url):
            return True
        return await self._references.listed_at(url)


__all__ = ["UsableReferenceClips"]
