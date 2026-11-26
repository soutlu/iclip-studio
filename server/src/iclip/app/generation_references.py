from __future__ import annotations

import uuid
from collections.abc import Sequence

from iclip.domains.generation.ports import VoiceSample
from iclip.domains.identity.public import Principal
from iclip.domains.references.infra_sql import SqlReferenceLookup
from iclip.domains.uploads.service import UploadService


class GenerationReferenceAssets:
    """生成域的 ``ReferenceAssets`` 接到参考资产库与上传台账上。"""

    def __init__(self, uploads: UploadService, references: SqlReferenceLookup) -> None:
        self._uploads = uploads
        self._references = references

    async def unlisted(self, reference_ids: Sequence[uuid.UUID]) -> tuple[uuid.UUID, ...]:
        return await self._references.unlisted(reference_ids)

    async def voice(self, reference_id: uuid.UUID) -> VoiceSample | None:
        found = await self._references.voice(reference_id)
        if found is None:
            return None
        url, transcript = found
        return VoiceSample(url=url, transcript=transcript)

    async def own_audio_upload(self, principal: Principal, upload_id: uuid.UUID) -> str | None:
        return await self._uploads.own_upload(principal, upload_id, kind="audio")


__all__ = ["GenerationReferenceAssets"]
