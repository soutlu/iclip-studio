from __future__ import annotations

import uuid

from agent_runtime.errors import NotFound, ValidationFailed

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.whole_film_schemas import WholeFilmDocument, WholeFilmVideoClip
from iclip.domains.generation.models import STATUS_COMPLETED, Inheritance, is_base_master
from iclip.domains.generation.repository import GenerationRepository, conversation_record
from iclip.domains.generation.schemas import KIND_AUDIO, KIND_SUBTITLE
from iclip.domains.identity.public import Principal


class GenerationDraftReferences:
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
        record = await conversation_record(
            self._generations,
            principal,
            job_id,
            conversation_id=conversation_id,
            inheritance=inheritance,
        )
        return record is not None and is_base_master(record)

    async def _subtitle_source(self, subtitle_id: uuid.UUID) -> uuid.UUID | None:
        try:
            subtitle = await self._generations.get(subtitle_id, owner=None)
        except NotFound:
            return None
        return subtitle.source_job_id if subtitle.kind == KIND_SUBTITLE else None


__all__ = ["GenerationDraftReferences"]
