"""成片草稿引用的生成记录，经组合根接到生成仓储上：对话域只管权限，记录合不合格在这里判。

只用生成仓储与对话的血缘，媒体生成没开也照样核对。"""

from __future__ import annotations

import uuid

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.whole_film_schemas import WholeFilmDocument, WholeFilmVideoClip
from iclip.domains.generation.models import STATUS_COMPLETED, Inheritance, is_base_master
from iclip.domains.generation.repository import GenerationRepository, conversation_record
from iclip.domains.generation.schemas import KIND_AUDIO, KIND_SUBTITLE
from iclip.domains.identity.public import Principal


class GenerationDraftReferences:
    """对话域的 ``WholeFilmDraftReferences``。

    画面轨与音乐按「这段对话自己的或继承来的」读记录，与生成域按对话列记录同一口径。字幕记录按
    id 直接读，再按同一口径核它的出处是这段对话读得到的素材片：继承来的素材片在分叉之后才识别完的
    字幕不在继承边界里，按对话读会漏掉它。出处不必还在画面轨上，删掉片段时改字留在草稿里。"""

    def __init__(
        self, *, generations: GenerationRepository, conversations: SqlConversationRepository
    ) -> None:
        self._generations = generations
        self._conversations = conversations

    async def __call__(
        self, principal: Principal, conversation_id: uuid.UUID, document: WholeFilmDocument
    ) -> None:
        inheritance = await self._conversations.ancestry(conversation_id)
        checked: set[uuid.UUID] = set()
        # 几段常出自同一条素材片，每条只读一次。
        for clip in document.layer0:
            if isinstance(clip, WholeFilmVideoClip) and clip.source_job_id not in checked:
                if not await self._is_master(
                    principal, conversation_id, inheritance, clip.source_job_id
                ):
                    raise ValidationFailed(
                        f"画面轨片段「{clip.id}」出自的 {clip.source_job_id} "
                        "不是这段对话自己的或继承来的一条素材片（出片或合成）"
                    )
                checked.add(clip.source_job_id)
        if document.music is not None:
            music = await conversation_record(
                self._generations,
                principal,
                document.music.job_id,
                conversation_id=conversation_id,
                inheritance=inheritance,
            )
            if (
                music is None
                or music.kind != KIND_AUDIO
                or music.status != STATUS_COMPLETED
                or music.output.url is None
            ):
                raise ValidationFailed(
                    f"音乐 {document.music.job_id} 不是这段对话里一条已完成的音频记录"
                )
        for subtitle_id in dict.fromkeys(edit.subtitle_job_id for edit in document.captions.edits):
            source = await self._subtitle_source(subtitle_id)
            if source is None or (
                source not in checked
                and not await self._is_master(principal, conversation_id, inheritance, source)
            ):
                raise ValidationFailed(
                    f"字幕记录 {subtitle_id} 不是这段对话自己的或继承来的一条素材片的字幕"
                )
            checked.add(source)

    async def _is_master(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        inheritance: Inheritance,
        job_id: uuid.UUID,
    ) -> bool:
        """``job_id`` 是不是这段对话自己的或继承来的一条素材片（出片或合成）。"""

        record = await conversation_record(
            self._generations,
            principal,
            job_id,
            conversation_id=conversation_id,
            inheritance=inheritance,
        )
        return record is not None and is_base_master(record)

    async def _subtitle_source(self, subtitle_id: uuid.UUID) -> uuid.UUID | None:
        """字幕记录识别的那条视频；没有这条或它不是字幕记录时为 ``None``。"""

        try:
            subtitle = await self._generations.get(subtitle_id, owner=None)
        except NotFound:
            return None
        return subtitle.source_job_id if subtitle.kind == KIND_SUBTITLE else None


__all__ = ["GenerationDraftReferences"]
