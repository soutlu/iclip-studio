from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Final, Literal

import structlog

from iclip.common.errors import NotFound, ValidationFailed
from iclip.common.shot_prompt import format_seconds
from iclip.domains.generation.film_schemas import (
    MAX_WHOLE_FILM_MS,
    WholeFilmBrand,
    WholeFilmBrandIn,
    WholeFilmFont,
    WholeFilmIn,
    WholeFilmMusic,
    WholeFilmMusicIn,
    WholeFilmRender,
    WholeFilmRequest,
    WholeFilmSegment,
    WholeFilmSegmentIn,
)
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    GenerationJob,
    Inheritance,
    is_base_master,
)
from iclip.domains.generation.ports import BrandTemplates, ConversationLineage, RemoteMediaProbe
from iclip.domains.generation.repository import GenerationRepository, conversation_record
from iclip.domains.generation.schemas import KIND_AUDIO
from iclip.domains.generation.segment_end import check_segment_end
from iclip.domains.identity.public import Principal
from iclip.platform.media.errors import MediaError
from iclip.platform.media.probe import VideoProfile

_logger = structlog.stdlib.get_logger(__name__)

BrandPosition = Literal["intro", "outro"]

_BRAND_LABELS: Final[Mapping[BrandPosition, str]] = {"intro": "片头", "outro": "片尾"}

MAX_BRAND_RATIO_DEVIATION: Final = 0.02
_FLOAT_SLACK: Final = 1e-9


# ADR-0003
def matches_film_ratio(brand: WholeFilmBrand, frame: VideoProfile) -> bool:
    deviation = abs(brand.width / brand.height / (frame.width / frame.height) - 1)
    return deviation <= MAX_BRAND_RATIO_DEVIATION + _FLOAT_SLACK


class WholeFilmAcceptance:
    def __init__(
        self,
        repo: GenerationRepository,
        *,
        lineage: ConversationLineage,
        brand_templates: BrandTemplates,
        media_probe: RemoteMediaProbe,
    ) -> None:
        self._repo = repo
        self._lineage = lineage
        self._brand_templates = brand_templates
        self._media_probe = media_probe

    async def settle(self, principal: Principal, request: WholeFilmIn) -> WholeFilmRequest:
        conversation_id = request.conversation_id
        if not await self._lineage.readable(principal, conversation_id):
            raise NotFound(f"没有这段对话: {conversation_id}")
        inheritance = await self._lineage.ancestry(conversation_id)
        segments = await self._segments(principal, request.segments, conversation_id, inheritance)
        intro = await self._brand(request.intro, "intro")
        outro = await self._brand(request.outro, "outro")
        film = WholeFilmRequest(
            segments=segments,
            subtitles=request.subtitles,
            music=None,
            render=WholeFilmRender(),
            font=await self._font(request.font_id),
            intro=intro,
            outro=outro,
        )
        if film.duration_ms > MAX_WHOLE_FILM_MS:
            raise ValidationFailed(
                f"连片头片尾整片一共 {format_seconds(film.duration_ms / 1000)} 秒，"
                f"超过 {format_seconds(MAX_WHOLE_FILM_MS / 1000)} 秒上限"
            )
        if request.music is not None:
            film = film.model_copy(
                update={
                    "music": await self._music(
                        principal, request.music, conversation_id, inheritance, film.segments_ms
                    )
                }
            )
        await self._check_brand_ratio(film)
        return film

    async def _segments(
        self,
        principal: Principal,
        requested: list[WholeFilmSegmentIn],
        conversation_id: uuid.UUID,
        inheritance: Inheritance,
    ) -> list[WholeFilmSegment]:
        sources: dict[uuid.UUID, GenerationJob] = {}
        for source_id in dict.fromkeys(segment.source_job_id for segment in requested):
            source = await conversation_record(
                self._repo,
                principal,
                source_id,
                conversation_id=conversation_id,
                inheritance=inheritance,
            )
            if source is None:
                raise NotFound(f"没有这次生成: {source_id}")
            if not is_base_master(source):
                raise ValidationFailed(
                    "整片的每段必须取自一条已完成的出片或合成；整片、编辑段与上传都不行"
                )
            sources[source_id] = source
        segments: list[WholeFilmSegment] = []
        for position, segment in enumerate(requested, start=1):
            source = sources[segment.source_job_id]
            if source.output_url is None:
                raise RuntimeError(f"生成记录 {source.id} 核对过却没有产物地址")
            check_segment_end(position, segment.end_ms, source.duration_ms)
            segments.append(
                WholeFilmSegment(
                    source_job_id=source.id,
                    url=source.output_url,
                    start_ms=segment.start_ms,
                    end_ms=segment.end_ms,
                    volume=segment.volume,
                )
            )
        return segments

    async def _music(
        self,
        principal: Principal,
        music: WholeFilmMusicIn,
        conversation_id: uuid.UUID,
        inheritance: Inheritance,
        segments_ms: int,
    ) -> WholeFilmMusic:
        audio = await conversation_record(
            self._repo,
            principal,
            music.audio_job_id,
            conversation_id=conversation_id,
            inheritance=inheritance,
            own_uploads=True,
        )
        if audio is None:
            raise NotFound(f"没有这次生成: {music.audio_job_id}")
        if not (
            audio.kind == KIND_AUDIO
            and audio.status == STATUS_COMPLETED
            and audio.output_url is not None
        ):
            raise ValidationFailed("音乐必须是一条已完成的音频记录：上传的音乐或生成的背景音乐")
        if audio.duration_ms is not None and music.offset_ms + segments_ms > audio.duration_ms:
            raise ValidationFailed(
                f"音乐从 {format_seconds(music.offset_ms / 1000)} 秒起只剩 "
                f"{format_seconds(max(0, audio.duration_ms - music.offset_ms) / 1000)} 秒，"
                f"不够整片的 {format_seconds(segments_ms / 1000)} 秒"
            )
        return WholeFilmMusic(
            audio_job_id=audio.id,
            url=audio.output_url,
            offset_ms=music.offset_ms,
            gain=music.gain,
            volume=music.volume,
        )

    async def _brand(
        self, brand: WholeFilmBrandIn | None, position: BrandPosition
    ) -> WholeFilmBrand | None:
        if brand is None:
            return None
        label = _BRAND_LABELS[position]
        template = await self._brand_templates(brand.template_id)
        if template is None:
            raise NotFound(f"没有这个品牌模板: {brand.template_id}")
        if not template.enabled:
            raise ValidationFailed(f"{label}用的品牌模板已停用")
        if template.kind != position:
            raise ValidationFailed(f"{label}只能用{label}模板")
        if (
            template.width is None
            or template.height is None
            or template.duration_ms is None
            or template.has_audio is None
            or template.width <= 0
            or template.height <= 0
            or template.duration_ms <= 0
        ):
            raise ValidationFailed(f"{label}视频参数不完整，无法合成；请重新上传模板")
        return WholeFilmBrand(
            template_id=template.id,
            url=template.url,
            duration_ms=template.duration_ms,
            width=template.width,
            height=template.height,
            has_audio=template.has_audio,
        )

    async def _font(self, font_id: uuid.UUID | None) -> WholeFilmFont | None:
        if font_id is None:
            return None
        font = await self._brand_templates(font_id)
        if font is None:
            raise NotFound("没有这个字幕字体")
        if font.kind != "font":
            raise ValidationFailed("字幕字体必须选择字体资源")
        if not font.enabled:
            raise ValidationFailed("字幕字体已停用，请选择其他字体")
        info = font.font_info
        if info is None:
            raise RuntimeError("字体资源适配器未提供字体信息")
        return WholeFilmFont(
            font_id=font.id,
            url=font.url,
            name=font.name,
            family=info.family,
            weight=info.weight,
            style=info.style,
        )

    async def _check_brand_ratio(self, film: WholeFilmRequest) -> None:
        brands = [
            (label, brand)
            for label, brand in (
                (_BRAND_LABELS["intro"], film.intro),
                (_BRAND_LABELS["outro"], film.outro),
            )
            if brand is not None
        ]
        if not brands:
            return
        first = film.segments[0]
        try:
            frame = await self._media_probe.video_profile(first.url)
        except MediaError as exc:
            _logger.warning("整片受理时读不出正文画幅", job_id=first.source_job_id, error=str(exc))
            raise ValidationFailed("正文的画面比例读取失败，请稍后重试") from exc
        for label, brand in brands:
            if not matches_film_ratio(brand, frame):
                raise ValidationFailed(
                    f"{label}模板的画面比例与正文不一致，无法合成；请选择比例相近的模板"
                )


__all__ = [
    "MAX_BRAND_RATIO_DEVIATION",
    "BrandPosition",
    "WholeFilmAcceptance",
    "matches_film_ratio",
]
