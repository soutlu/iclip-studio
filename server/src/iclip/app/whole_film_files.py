from __future__ import annotations

import uuid

from iclip.common.errors import ValidationFailed
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.models import CheckedWholeFilm, WholeFilmSource
from iclip.domains.conversations.repository import WholeFilmDraftStore
from iclip.domains.conversations.service import WholeFilmRenderUnavailable
from iclip.domains.generation.models import is_base_master
from iclip.domains.generation.render import FilmAt, RenderClient, RenderRejected, RenderUnavailable
from iclip.domains.generation.repository import GenerationRepository, conversation_record
from iclip.domains.identity.public import Principal


class WholeFilmFileChecker:
    """成片文件的写法交给渲染服务查；用到的素材在这里查是不是这段对话的素材片。"""

    def __init__(
        self,
        *,
        render: RenderClient,
        generations: GenerationRepository,
        conversations: SqlConversationRepository,
    ) -> None:
        self._render = render
        self._generations = generations
        self._conversations = conversations

    async def check(
        self, principal: Principal, conversation_id: uuid.UUID, html: str
    ) -> CheckedWholeFilm:
        try:
            checked = await self._render.check(html)
        except RenderRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        except RenderUnavailable as exc:
            raise WholeFilmRenderUnavailable(str(exc)) from exc
        inheritance = await self._conversations.ancestry(conversation_id)
        for source in checked.sources:
            record = await conversation_record(
                self._generations,
                principal,
                source.job_id,
                conversation_id=conversation_id,
                inheritance=inheritance,
            )
            if record is None or not is_base_master(record):
                raise ValidationFailed(
                    f"成片用到的 {source.job_id} "
                    "不是这段对话自己的或继承来的一条素材片（出片或合成）"
                )
            if record.output.url != source.url:
                raise ValidationFailed(f"成片里素材片 {source.job_id} 的地址和它记录上的不一样")
        return CheckedWholeFilm(
            html=checked.html,
            duration_ms=checked.duration_ms,
            sources=tuple(
                WholeFilmSource(job_id=source.job_id, url=source.url) for source in checked.sources
            ),
        )


def draft_film_at(drafts: WholeFilmDraftStore) -> FilmAt:
    """导出交给渲染服务时取成片文件：草稿还是导出时那一版才给。"""

    async def film_at(conversation_id: uuid.UUID, revision: int) -> str | None:
        draft = await drafts.get(conversation_id)
        if draft is None or draft.revision != revision:
            return None
        return draft.html

    return film_at


__all__ = ["WholeFilmFileChecker", "draft_film_at"]
