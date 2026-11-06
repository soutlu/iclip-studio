from __future__ import annotations

import asyncio
import uuid
from typing import Final, Protocol

import structlog
from agent_runtime.errors import ValidationFailed
from agent_runtime.transcript.ops import ImageContent, PromptContent
from agent_runtime.urls import is_http_url, is_oss_processable

from iclip.domains.identity.public import Principal

_logger = structlog.stdlib.get_logger(__name__)

UPLOAD_ID_NAMESPACE: Final = uuid.UUID("c14654b9-c134-4d85-9746-ebe95a5b8263")


def needs_import(url: str) -> bool:
    return is_http_url(url) and not is_oss_processable(url)


class ImportImage(Protocol):
    async def __call__(self, principal: Principal, url: str, *, upload_id: uuid.UUID) -> str: ...


class PromptAttachmentImporter:
    def __init__(self, import_image: ImportImage) -> None:
        self._import_image = import_image

    async def __call__(
        self,
        principal: Principal,
        *,
        conversation_id: str,
        prompt_id: str | None,
        content: tuple[PromptContent, ...],
    ) -> tuple[PromptContent, ...]:
        ordinals: dict[str, int] = {}
        attachments = (part for part in content if part.type != "text")
        for ordinal, part in enumerate(attachments, start=1):
            url = part.source.url
            if isinstance(part, ImageContent) and url is not None and needs_import(url):
                ordinals.setdefault(url, ordinal)
        if not ordinals:
            return content
        results = await asyncio.gather(
            *(self._import(principal, conversation_id, prompt_id, url) for url in ordinals),
            return_exceptions=True,
        )
        imported: dict[str, str] = {}
        for (url, ordinal), result in zip(ordinals.items(), results, strict=True):
            if isinstance(result, ValidationFailed):
                raise ValidationFailed(f"第 {ordinal} 张附件转存不了：{result}") from result
            if isinstance(result, BaseException):
                raise result
            imported[url] = result
        return tuple(_relocated(part, imported) for part in content)

    async def _import(
        self, principal: Principal, conversation_id: str, prompt_id: str | None, url: str
    ) -> str:
        upload_id = (
            uuid.uuid4()
            if prompt_id is None
            else uuid.uuid5(
                UPLOAD_ID_NAMESPACE, f"{principal.user_id}|{conversation_id}|{prompt_id}|{url}"
            )
        )
        stored = await self._import_image(principal, url, upload_id=upload_id)
        _logger.info(
            "附件图片已转存",
            conversation_id=conversation_id,
            prompt_id=prompt_id,
            upload_id=str(upload_id),
            source_url=url,
            url=stored,
        )
        return stored


def _relocated(part: PromptContent, imported: dict[str, str]) -> PromptContent:
    if not isinstance(part, ImageContent) or part.source.url not in imported:
        return part
    source = part.source.model_copy(update={"url": imported[part.source.url]})
    return part.model_copy(update={"source": source})


__all__ = ["UPLOAD_ID_NAMESPACE", "ImportImage", "PromptAttachmentImporter", "needs_import"]
