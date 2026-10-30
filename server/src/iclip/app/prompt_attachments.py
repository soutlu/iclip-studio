"""发消息的附件接到 uploads：挂不上 OSS 处理参数的图片地址先转存进本桶，消息里存新地址。

给模型的缩图、查图片信息、缩放与裁切都要在地址后面挂 OSS 处理参数；外部地址、带签名 query 的
地址挂不上，受理前在这里换成本桶里的一份。视频不挂参数，不转存。
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Final, Protocol

import structlog
from agent_runtime.errors import ValidationFailed
from agent_runtime.urls import is_http_url, is_oss_processable

from iclip.domains.identity.public import Principal
from iclip.platform.transcript.ops import ImageContent, PromptContent

_logger = structlog.stdlib.get_logger(__name__)

UPLOAD_ID_NAMESPACE: Final = uuid.UUID("c14654b9-c134-4d85-9746-ebe95a5b8263")
"""转存的上传 id 按（主体，对话，消息 id，原地址）在这个命名空间里算 uuid5，同一条消息重发
时算出同一个 id，uploads 认出记过就不再下载。改了它，已转存的消息重发会再转一份。"""


def needs_import(url: str) -> bool:
    """是 http(s) 地址却挂不上 OSS 处理参数。不是 http(s) 的不转存，留给受理时的校验返回 422。"""

    return is_http_url(url) and not is_oss_processable(url)


class ImportImage(Protocol):
    """uploads 的按地址转存一张图片（``UploadService.import_image``）。"""

    async def __call__(self, principal: Principal, url: str, *, upload_id: uuid.UUID) -> str: ...


class PromptAttachmentImporter:
    """``ImportAttachments`` 端口的实现：逐个找出要转存的图片附件，并发交给 uploads 转存，
    再把消息里的地址换掉。同一个地址出现几次只转一次。"""

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
        """交回换过地址的 content。有一张转存不了（``ValidationFailed``）就整条拒绝，报错里说是
        第几张附件；同时在转的其余几张照样转完、记录保留，同一个 ``prompt_id`` 重发时直接复用。
        写桶等其他失败原样抛出。"""

        # 原地址 → 它第一次出现时是第几张附件（图片与视频一起从 1 数）。
        ordinals: dict[str, int] = {}
        attachments = (part for part in content if part.type != "text")
        for ordinal, part in enumerate(attachments, start=1):
            url = part.source.url
            if isinstance(part, ImageContent) and url is not None and needs_import(url):
                ordinals.setdefault(url, ordinal)
        if not ordinals:
            return content
        # 等所有转存都有结果再报错：已经转成的留下记录，重发同一条消息时不再下载。
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
        # 不带消息 id 的重新生成没有可复算的键，每次都算一个新的。
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
