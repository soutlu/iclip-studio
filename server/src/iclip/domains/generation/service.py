from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog
from iclip_video.shot_prompt import format_seconds

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.domains.generation.clip_models import UpstreamMode, clip_model
from iclip.domains.generation.model_groups import ModelGroups
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationOutput,
    InFlightPhase,
    Inheritance,
    is_base_master,
    is_finished_edit,
)
from iclip.domains.generation.ports import (
    ConversationLineage,
    ReferenceAssets,
    RemoteMediaProbe,
)
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.queue import GenerationQueue
from iclip.domains.generation.render import CANCELLED, CANCELLED_MESSAGE, RenderClient
from iclip.domains.generation.render import PROVIDER_NAME as RENDER_PROVIDER_NAME
from iclip.domains.generation.repository import GenerationRepository, conversation_record
from iclip.domains.generation.schemas import (
    KIND_IMAGE,
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_GENERATE,
    OPERATION_RENDER,
    OPERATION_TRIAL,
    ComposeSegment,
    DubbingIn,
    DubbingLine,
    DubbingOriginalReference,
    DubbingReference,
    DubbingRequest,
    DubbingSpeechSpan,
    DubbingUploadReference,
    DubbingVoiceReference,
    DubbingVoiceReferenceIn,
    GenerationKind,
    GenerationOperation,
    GenerationStatus,
    ImageGenerationIn,
    MusicIn,
    MusicRequest,
    SpeechIn,
    SpeechRequest,
    SubtitleIn,
    SubtitleRequest,
    VideoComposeIn,
    VideoComposeRequest,
    VideoEditIn,
    VideoEditRequest,
    VideoEnhanceIn,
    VideoEnhanceRequest,
    VideoEnhanceResolution,
    VideoGenerationIn,
    VideoModelsOut,
    WholeFilmRequest,
)
from iclip.domains.generation.segment_end import check_segment_end, exceeds_source
from iclip.domains.generation.stored_requests import GenerationRequest
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as
from iclip.platform.media.errors import MediaError
from iclip.platform.paging import check_limit

_logger = structlog.stdlib.get_logger(__name__)

ClearCompletion = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]

_MAX_FIRST_FRAMES = 2
_CONCRETE_RATIO = re.compile(r"\d+(\.\d+)?:\d+(\.\d+)?")


@dataclass(frozen=True, slots=True)
class ProviderTarget:
    provider: str
    model: str


@dataclass(frozen=True, slots=True)
class VideoEnhanceSpec:
    model: str
    resolutions: tuple[VideoEnhanceResolution, ...]
    fps: int | None


@dataclass(frozen=True, slots=True)
class EnhanceTier:
    resolution: VideoEnhanceResolution
    job: GenerationJob | None


@dataclass(frozen=True, slots=True)
class VideoEnhancements:
    tiers: tuple[EnhanceTier, ...]


class GenerationService:
    def __init__(
        self,
        repo: GenerationRepository,
        queue: GenerationQueue,
        *,
        video_provider_name: str,
        compose_provider_name: str,
        video_default_model: str,
        video_allowed_models: tuple[str, ...],
        image_models: Mapping[str, ImageModelSpec],
        image_default_model: str,
        clear_completion: ClearCompletion,
        lineage: ConversationLineage,
        media_probe: RemoteMediaProbe,
        references: ReferenceAssets,
        subtitles: ProviderTarget | None = None,
        dubbing_provider: str | None = None,
        music: ProviderTarget | None = None,
        render: RenderClient | None = None,
        enhance: VideoEnhanceSpec | None = None,
        model_groups: ModelGroups,
    ) -> None:
        self._repo = repo
        self._model_groups = model_groups
        self._enhance = enhance
        self._render = render
        self._queue = queue
        self._video_provider_name = video_provider_name
        self._compose_provider_name = compose_provider_name
        self._video_default_model = video_default_model
        self._video_allowed_models = video_allowed_models
        self._image_models = image_models
        self._image_default_model = image_default_model
        self._clear_completion = clear_completion
        self._lineage = lineage
        self._media_probe = media_probe
        self._references = references
        self._subtitles = subtitles
        self._dubbing_provider = dubbing_provider
        self._music = music

    async def _inheritance(
        self, principal: Principal, conversation_id: uuid.UUID | None
    ) -> Inheritance:
        if conversation_id is None or not await self._lineage.readable(principal, conversation_id):
            return ()
        return await self._lineage.ancestry(conversation_id)

    async def submit_video(self, principal: Principal, request: VideoGenerationIn) -> GenerationJob:
        """受理一次出片；传进来的是 ``VideoTrialRequest`` 时记成试生成，别的都一样。"""

        self._require_video_model(request.model)
        _require_user_name(request.user_name)
        if request.reference_ids:
            unlisted = await self._references.unlisted(request.reference_ids)
            if unlisted:
                raise ValidationFailed(
                    f"reference_ids 里这些参考不在资料库里或已移除：{'、'.join(map(str, unlisted))}"
                )
        model_group, upstream_model = await self._model_groups.video_model_of(
            principal.user_id, request.model
        )
        return await self._accept(
            principal,
            request,
            provider=self._video_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=request.shot_index,
            model_group=model_group,
            upstream_model=upstream_model,
        )

    async def submit_video_edit(self, principal: Principal, request: VideoEditIn) -> GenerationJob:
        self._require_video_model(request.model)
        clip_spec = clip_model(request.model)
        if clip_spec is None:
            raise ValidationFailed(f"{request.model} 尚未接入片段生成")
        spec = clip_spec.spec
        upstream = clip_spec.edit_mode if request.reference_video_urls else UpstreamMode()
        _require_user_name(request.user_name)
        if len(request.reference_image_urls) > spec.max_reference_images:
            raise ValidationFailed(
                f"{request.model} 最多支持 {spec.max_reference_images} 张参考图片"
            )
        if request.reference_video_urls:
            if spec.edit is None:
                raise ValidationFailed(f"{request.model} 不支持片段编辑")
            if request.seconds != -1:
                raise ValidationFailed("片段编辑的 seconds 必须为 -1，跟随实际参考时长")
        else:
            if not request.reference_image_urls:
                raise ValidationFailed("图生视频至少需要引用一张图片")
            if not spec.image.min_seconds <= request.seconds <= spec.image.max_seconds:
                raise ValidationFailed(
                    f"{request.model} 图生时长必须为 "
                    f"{spec.image.min_seconds}–{spec.image.max_seconds} 秒的整数"
                )
        options = upstream.options(request.provider_options)
        base = await self._check_source(principal, request.source_job_id, request.conversation_id)
        _require_base(base)
        aspect_ratio = None
        if (
            not request.reference_video_urls
            and len(request.reference_image_urls) > _MAX_FIRST_FRAMES
        ):
            aspect_ratio = await self._original_aspect_ratio(
                principal, base, request.conversation_id
            )
        clip_url = None
        if request.reference_video_urls:
            (clip_url,) = request.reference_video_urls
            if not await self._references.usable_clip(principal, clip_url):
                raise ValidationFailed(
                    "reference_video_urls 必须是调用者本人上传的视频，或资料库里的一条参考视频"
                )
        base_ms = base.output.duration_ms
        if base_ms is None:
            base_ms = await self._probe_duration(base.output.url, what="基底", job_id=base.id)
        _check_edit_range(request.range_start_ms, request.range_end_ms, base_ms)
        if clip_url is not None and spec.edit is not None:
            clip_ms = await self._probe_duration(clip_url, what="参考片段", job_id=None)
            if not spec.edit.min_seconds * 1000 <= clip_ms <= spec.edit.max_seconds * 1000:
                raise ValidationFailed(
                    f"{request.model} 编辑参考时长必须为 "
                    f"{spec.edit.min_seconds}–{spec.edit.max_seconds} 秒"
                )
        edit = VideoEditRequest(
            model=request.model,
            prompt=upstream.prompt(request.prompt),
            user_name=request.user_name,
            reference_image_urls=request.reference_image_urls,
            reference_video_urls=request.reference_video_urls,
            # 不带分辨率时由上游自己定档，和原片不是一档的话合成时就得缩放。
            resolution=await self._original_resolution(base),
            aspect_ratio=aspect_ratio,
            seconds=request.seconds,
            provider_options=options,
            range_start_ms=request.range_start_ms,
            range_end_ms=request.range_end_ms,
        )
        model_group, upstream_model = await self._model_groups.video_model_of(
            principal.user_id, request.model
        )
        return await self._accept(
            principal,
            edit,
            provider=self._video_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=base.shot_index,
            root_job_id=base.root_job_id or base.id,
            source_job_id=base.id,
            model_group=model_group,
            upstream_model=upstream_model,
        )

    async def submit_video_compose(
        self, principal: Principal, request: VideoComposeIn
    ) -> GenerationJob:
        _require_user_name(request.user_name)
        base = await self._check_source(principal, request.base_job_id, request.conversation_id)
        _require_base(base)
        sources = {base.id: base}
        for source_id in dict.fromkeys(segment.source_job_id for segment in request.segments):
            if source_id in sources:
                continue
            edit = await self._check_source(principal, source_id, request.conversation_id)
            if not is_finished_edit(edit) or edit.source_job_id != base.id:
                raise ValidationFailed("每段必须出自基底本身，或基于这个基底的一条已完成编辑段")
            sources[source_id] = edit
        segments: list[ComposeSegment] = []
        for position, segment in enumerate(request.segments, start=1):
            source = sources[segment.source_job_id]
            if source.output.url is None:
                raise RuntimeError(f"生成记录 {source.id} 核对过却没有产物地址")
            if segment.end is not None:
                check_segment_end(position, round(segment.end * 1000), source.output.duration_ms)
            segments.append(
                ComposeSegment(
                    source_job_id=source.id,
                    url=source.output.url,
                    start=segment.start,
                    end=segment.end,
                )
            )
        return await self._accept(
            principal,
            VideoComposeRequest(segments=segments, user_name=request.user_name),
            provider=self._compose_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=base.shot_index,
            root_job_id=base.root_job_id or base.id,
            source_job_id=base.id,
        )

    async def _check_source(
        self, principal: Principal, source_id: uuid.UUID, conversation_id: uuid.UUID | None
    ) -> GenerationJob:
        source = await conversation_record(
            self._repo,
            principal,
            source_id,
            conversation_id=conversation_id,
            inheritance=await self._inheritance(principal, conversation_id),
        )
        if source is None:
            raise ValidationFailed("来源不是这段对话自己的或继承来的一条记录")
        return source

    async def _original_aspect_ratio(
        self, principal: Principal, base: GenerationJob, conversation_id: uuid.UUID | None
    ) -> str:
        original = (
            base
            if base.root_job_id is None
            else await self._check_source(principal, base.root_job_id, conversation_id)
        )
        request = original.request
        ratio = request.aspect_ratio if isinstance(request, VideoGenerationIn) else None
        if ratio is None or _CONCRETE_RATIO.fullmatch(ratio) is None:
            raise ValidationFailed(
                f"原片没有记录画幅，无法用 {_MAX_FIRST_FRAMES + 1} 张及以上图片生成；"
                f"请改用 {_MAX_FIRST_FRAMES} 张以内的图片"
            )
        return ratio

    async def _probe_duration(self, url: str | None, *, what: str, job_id: uuid.UUID | None) -> int:
        if url is None:
            raise RuntimeError(f"生成记录 {job_id} 核对过却没有产物地址")
        try:
            return await self._media_probe.duration_ms(url)
        except MediaError as exc:
            _logger.warning("受理时探不出时长", what=what, job_id=job_id, error=str(exc))
            raise ValidationFailed(f"读不出{what}的时长，请稍后重试") from exc

    def _require_video_model(self, model: str) -> None:
        if model not in self._video_allowed_models:
            raise ValidationFailed(f"视频生成仅支持模型 {'、'.join(self._video_allowed_models)}")

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        _require_user_name(request.user_name)
        settled, model = self._settle_image_model(request)
        base_id, external = await self._resolve_base(
            principal, request.source_url, request.conversation_id
        )
        return await self._accept(
            principal,
            settled.model_copy(update={"source_url": external}),
            provider=model,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=None,
            source_job_id=base_id,
        )

    async def _resolve_base(
        self, principal: Principal, url: str | None, conversation_id: uuid.UUID | None
    ) -> tuple[uuid.UUID | None, str | None]:
        """底图是这段对话（或继承来）的一张生成图时记来源；别的地址（上传的图、外链）原样记下。"""

        if url is None:
            return None, None
        found = await self._repo.find_by_output(
            url,
            kind=KIND_IMAGE,
            owner=visible_owner_incl_act_as(principal),
            conversation_id=conversation_id,
            inherited=await self._inheritance(principal, conversation_id),
        )
        return (None, url) if found is None else (found.id, None)

    async def _accept(
        self,
        principal: Principal,
        request: GenerationRequest,
        *,
        provider: str,
        conversation_id: uuid.UUID | None,
        task_id: uuid.UUID | None,
        metadata: dict[str, Any] | None,
        shot_index: int | None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        model_group: str | None = None,
        upstream_model: str | None = None,
    ) -> GenerationJob:
        created = await self._queue_new(
            _pending_job(
                request,
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=provider,
                conversation_id=conversation_id,
                task_id=task_id,
                metadata=metadata,
                shot_index=shot_index,
                root_job_id=root_job_id,
                source_job_id=source_job_id,
                model_group=model_group,
                upstream_model=upstream_model,
            )
        )
        await self._note_conversation_active(created)
        return created

    async def _queue_new(self, job: GenerationJob) -> GenerationJob:
        created = await self._repo.create(job)
        try:
            await self._queue.enqueue_submit(created)
        except Exception as exc:
            await self._repo.mark_failed(
                created.id,
                error_code="QUEUE_DEFER_FAILED",
                error_message=f"受理了但没能排进队列，请重新发起：{exc}",
            )
            raise
        return created

    async def _readable_master(
        self,
        principal: Principal,
        source_job_id: uuid.UUID,
        conversation_id: uuid.UUID | None,
        *,
        refusal: str,
    ) -> tuple[GenerationJob, str]:
        video = await conversation_record(
            self._repo,
            principal,
            source_job_id,
            conversation_id=conversation_id,
            inheritance=await self._inheritance(principal, conversation_id),
        )
        if video is None:
            raise NotFound(f"没有这次生成: {source_job_id}")
        if not is_base_master(video) or video.output.url is None:
            raise ValidationFailed(refusal)
        return video, video.output.url

    async def submit_subtitle(self, principal: Principal, request: SubtitleIn) -> GenerationJob:
        subtitles = self._require_subtitles()
        video, video_url = await self._readable_master(
            principal,
            request.source_job_id,
            request.conversation_id,
            refusal="只能识别素材片：已完成的出片或合成",
        )
        return await self._queue_new(
            _pending_job(
                SubtitleRequest(model=subtitles.model, video_url=video_url),
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=subtitles.provider,
                conversation_id=request.conversation_id,
                task_id=request.task_id,
                metadata=request.metadata,
                shot_index=None,
                source_job_id=video.id,
                model_group=await self._model_groups.group_of(principal.user_id),
            )
        )

    def _require_subtitles(self) -> ProviderTarget:
        if self._subtitles is None:
            raise ValidationFailed("字幕识别没有开通，暂时不能识别")
        return self._subtitles

    async def submit_dubbing(self, principal: Principal, request: DubbingIn) -> GenerationJob:
        dubbing_provider = self._require_dubbing()
        reference = await self._dubbing_reference(principal, request)
        video, video_url = await self._readable_master(
            principal,
            request.source_job_id,
            request.conversation_id,
            refusal="只能给素材片配音：已完成的出片或合成",
        )
        duration_ms = video.output.duration_ms
        if duration_ms is None:
            duration_ms = await self._probe_duration(video_url, what="素材片", job_id=video.id)
        _check_within_take(request.lines, duration_ms, what="句")
        if isinstance(request.reference, DubbingOriginalReference) and request.reference.spans:
            _check_within_take(request.reference.spans, duration_ms, what="段说话时段")
        return await self._queue_new(
            _pending_job(
                DubbingRequest(
                    video_url=video_url,
                    video_duration_ms=duration_ms,
                    locale=request.locale,
                    lines=request.lines,
                    reference=reference,
                ),
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=dubbing_provider,
                conversation_id=request.conversation_id,
                task_id=request.task_id,
                metadata=request.metadata,
                shot_index=None,
                source_job_id=video.id,
                model_group=await self._model_groups.group_of(principal.user_id),
            )
        )

    async def submit_speech(self, principal: Principal, request: SpeechIn) -> GenerationJob:
        """按文字合成一段语音，和配音同一个通道。给了对话时要读得到它。"""

        dubbing_provider = self._require_dubbing()
        reference = await self._voice_reference(request.reference)
        if request.conversation_id is not None and not await self._lineage.readable(
            principal, request.conversation_id
        ):
            raise NotFound(f"没有这段对话: {request.conversation_id}")
        return await self._queue_new(
            _pending_job(
                SpeechRequest(
                    text=request.text,
                    locale=request.locale,
                    reference=reference,
                    max_duration_ms=request.max_duration_ms,
                ),
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=dubbing_provider,
                conversation_id=request.conversation_id,
                task_id=request.task_id,
                metadata=request.metadata,
                shot_index=None,
                model_group=await self._model_groups.group_of(principal.user_id),
            )
        )

    def _require_dubbing(self) -> str:
        if self._dubbing_provider is None:
            raise ValidationFailed("配音没有开通，暂时不能配音")
        return self._dubbing_provider

    async def _dubbing_reference(
        self, principal: Principal, request: DubbingIn
    ) -> DubbingReference:
        """把请求里的参考换成记进记录的样子：音色读出地址与台词，上传读出地址。"""

        reference = request.reference
        if isinstance(reference, DubbingOriginalReference):
            return reference
        if isinstance(reference, DubbingVoiceReferenceIn):
            return await self._voice_reference(reference)
        url = await self._references.own_audio_upload(principal, reference.upload_id)
        if url is None:
            raise ValidationFailed("参考音频要用调用者本人的一条音频上传")
        return DubbingUploadReference(kind="upload", upload_id=reference.upload_id, url=url)

    async def _voice_reference(self, reference: DubbingVoiceReferenceIn) -> DubbingVoiceReference:
        voice = await self._references.voice(reference.reference_id)
        if voice is None:
            raise ValidationFailed("参考音频要用参考音频库里一条没移除的音色")
        return DubbingVoiceReference(
            kind="reference_audio",
            reference_id=reference.reference_id,
            url=voice.url,
            transcript=voice.transcript,
        )

    async def submit_music(self, principal: Principal, request: MusicIn) -> GenerationJob:
        if self._music is None:
            raise ValidationFailed("生成背景音乐没有开通，暂时不能生成")
        if not await self._lineage.readable(principal, request.conversation_id):
            raise NotFound(f"没有这段对话: {request.conversation_id}")
        return await self._queue_new(
            _pending_job(
                MusicRequest(model=self._music.model, prompt=request.prompt),
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=self._music.provider,
                conversation_id=request.conversation_id,
                task_id=request.task_id,
                metadata=request.metadata,
                shot_index=None,
                model_group=await self._model_groups.group_of(principal.user_id),
            )
        )

    async def submit_whole_film(
        self, principal: Principal, *, conversation_id: uuid.UUID, request: WholeFilmRequest
    ) -> GenerationJob:
        self._require_render()
        return await self._queue_new(
            _pending_job(
                request,
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=RENDER_PROVIDER_NAME,
                conversation_id=conversation_id,
                task_id=None,
                metadata=None,
                shot_index=None,
            )
        )

    async def cancel_whole_film(self, job: GenerationJob) -> None:
        render = self._require_render()
        if job.status == STATUS_PENDING:
            if await self._mark_cancelled(job.id, only_if_status=STATUS_PENDING) is not None:
                return
            job = await self._repo.get(job.id, owner=None)
        if job.status == STATUS_SUBMITTING:
            raise Conflict("正在交给渲染服务，稍后再取消")
        if job.status != STATUS_SUBMITTED:
            return
        await render.cancel(job.id)
        if await self._mark_cancelled(job.id, only_if_status=STATUS_SUBMITTED) is None:
            _logger.info("成片导出在取消之前已有结论，不改它", job_id=job.id)

    async def _mark_cancelled(
        self, job_id: uuid.UUID, *, only_if_status: GenerationStatus
    ) -> GenerationJob | None:
        return await self._repo.mark_failed(
            job_id,
            error_code=CANCELLED,
            error_message=CANCELLED_MESSAGE,
            only_if_status=only_if_status,
        )

    def _require_render(self) -> RenderClient:
        if self._render is None:
            raise ValidationFailed("成片导出没有开通")
        return self._render

    async def submit_video_enhance(
        self, principal: Principal, request: VideoEnhanceIn
    ) -> GenerationJob:
        enhance = self._require_enhance()
        source = await self._repo.get(request.source_job_id, owner=None)
        if not _enhanceable(source) or source.output.url is None:
            raise ValidationFailed("只有素材片（已完成的出片或合成）与导出完成的成片能做高清版")
        tiers = await self._enhance_tiers(enhance, source)
        if request.resolution not in tiers:
            if not tiers:
                raise ValidationFailed("这条视频已经足够清晰，没有更高的高清版可做")
            raise ValidationFailed(
                f"这条视频做不了 {request.resolution} 高清版，可选 {'、'.join(tiers)}"
            )
        for existing in await self._repo.enhancements_of(source.id):
            if existing.status != STATUS_FAILED and _enhanced_to(existing) == request.resolution:
                return existing
        if request.user_name is None:
            raise ValidationFailed("user_name 必填")
        model_group, upstream_model = await self._model_groups.video_model_of(
            principal.user_id, enhance.model
        )
        return await self._queue_new(
            _pending_job(
                VideoEnhanceRequest(
                    model=enhance.model,
                    resolution=request.resolution,
                    fps=enhance.fps,
                    video_url=source.output.url,
                    user_name=request.user_name,
                ),
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=self._video_provider_name,
                conversation_id=None,
                task_id=None,
                metadata=None,
                shot_index=source.shot_index,
                source_job_id=source.id,
                model_group=model_group,
                upstream_model=upstream_model,
            )
        )

    async def enhancements(self, job_id: uuid.UUID) -> VideoEnhancements:
        source = await self._repo.get(job_id, owner=None)
        if not _enhanceable(source) or self._enhance is None:
            return VideoEnhancements(tiers=())
        latest: dict[VideoEnhanceResolution, GenerationJob] = {}
        for job in await self._repo.enhancements_of(source.id):
            resolution = _enhanced_to(job)
            if resolution is not None:
                latest.setdefault(resolution, job)
        return VideoEnhancements(
            tiers=tuple(
                EnhanceTier(resolution=resolution, job=latest.get(resolution))
                for resolution in await self._enhance_tiers(self._enhance, source)
            ),
        )

    def _require_enhance(self) -> VideoEnhanceSpec:
        if self._enhance is None:
            raise ValidationFailed("高清版没有开通，暂时不能生成")
        return self._enhance

    async def _enhance_tiers(
        self, enhance: VideoEnhanceSpec, source: GenerationJob
    ) -> tuple[VideoEnhanceResolution, ...]:
        edge = await self._short_edge(source)
        return tuple(
            resolution
            for resolution in enhance.resolutions
            if edge is None or (_short_edge_of(resolution) or 0) > edge
        )

    async def _short_edge(self, source: GenerationJob) -> int | None:
        video = source
        if video.kind == KIND_WHOLE_FILM:
            if not isinstance(video.request, WholeFilmRequest) or not video.request.videos:
                return None
            first = await self._find(video.request.videos[0].job_id)
            if first is None or not is_base_master(first):
                return None
            video = first
        return _short_edge_of(await self._original_resolution(video))

    async def _original_resolution(self, video: GenerationJob) -> str | None:
        if video.operation == OPERATION_COMPOSE:
            if video.root_job_id is None:
                return None
            root = await self._find(video.root_job_id)
            if root is None:
                return None
            video = root
        if not isinstance(video.request, VideoGenerationIn):
            return None
        return video.request.resolution

    async def _find(self, job_id: uuid.UUID) -> GenerationJob | None:
        try:
            return await self._repo.get(job_id, owner=None)
        except NotFound:
            return None

    async def _note_conversation_active(self, job: GenerationJob) -> None:
        if job.conversation_id is None:
            return
        try:
            await self._clear_completion(job.conversation_id, job.owner_user_id)
        except Exception:
            _logger.warning(
                "取消对话收尾标记失败",
                job_id=job.id,
                conversation_id=job.conversation_id,
                exc_info=True,
            )

    def _settle_image_model(self, request: ImageGenerationIn) -> tuple[ImageGenerationIn, str]:
        model = request.model or self._image_default_model
        spec = self._image_models.get(model)
        if spec is None:
            raise ValidationFailed(f"图片生成仅支持模型 {'、'.join(self._image_models)}")
        if request.aspect_ratio not in spec.aspect_ratios:
            raise ValidationFailed(
                f"{model} 不支持画幅 {request.aspect_ratio}，可选 {'、'.join(spec.aspect_ratios)}"
            )
        if request.resolution not in spec.resolutions:
            raise ValidationFailed(
                f"{model} 不支持分辨率 {request.resolution}，可选 {'、'.join(spec.resolutions)}"
            )
        if request.channel is not None and not spec.channels:
            raise ValidationFailed(f"{model} 没有渠道这个轴，不要传 channel")
        if request.channel is not None and request.channel not in spec.channels:
            raise ValidationFailed(
                f"{model} 不支持渠道 {request.channel}，可选 {'、'.join(spec.channels)}"
            )
        channel = request.channel or (spec.channels[0] if spec.channels else None)
        return request.model_copy(update={"model": model, "channel": channel}), model

    def video_models(self) -> VideoModelsOut:
        return VideoModelsOut(
            default=self._video_default_model,
            items=list(self._video_allowed_models),
            clip_models=[
                clip.spec for model in self._video_allowed_models if (clip := clip_model(model))
            ],
        )

    def image_models(self) -> tuple[str, tuple[tuple[str, ImageModelSpec], ...]]:
        return self._image_default_model, tuple(self._image_models.items())

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        return await self._repo.get(job_id, owner=visible_owner_incl_act_as(principal))

    async def source_addresses(self, jobs: Sequence[GenerationJob]) -> Mapping[uuid.UUID, str]:
        outputs = await self._repo.output_urls(
            {job.source_job_id for job in jobs if job.source_job_id is not None}
        )
        addresses: dict[uuid.UUID, str] = {}
        for job in jobs:
            if isinstance(job.request, ImageGenerationIn) and job.request.source_url is not None:
                addresses[job.id] = job.request.source_url
            elif job.source_job_id is not None and job.source_job_id in outputs:
                addresses[job.id] = outputs[job.source_job_id]
        return addresses

    async def get_video(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        job = await self.get(principal, job_id)
        if job.kind != KIND_VIDEO or job.operation not in (OPERATION_GENERATE, OPERATION_TRIAL):
            raise NotFound(f"没有这个视频任务: {job_id}")
        return job

    async def in_flight_by_conversation(
        self, *, owner: uuid.UUID | None, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        return await self._repo.in_flight_by_conversation(owner=owner, kind=kind)

    async def latest_master_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, str]:
        return await self._repo.latest_master_by_conversation(conversation_ids)

    async def list_recent(
        self,
        principal: Principal,
        *,
        limit: int = 20,
        conversation_id: uuid.UUID | None = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        metadata: Mapping[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        shot_index: int | None = None,
        root_job_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        before: uuid.UUID | None = None,
    ) -> tuple[GenerationJob, ...]:
        check_limit(limit)
        return await self._repo.list_for_owner(
            owner=visible_owner_incl_act_as(principal),
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            operation=operation,
            metadata=metadata,
            task_id=task_id,
            shot_index=shot_index,
            root_job_id=root_job_id,
            source_job_id=source_job_id,
            before=before,
            inherited=await self._inheritance(principal, conversation_id),
        )


def _require_base(job: GenerationJob) -> None:
    if not is_base_master(job):
        raise ValidationFailed("基底必须是一条已完成的素材片（出片或合成）")


def _enhanceable(job: GenerationJob) -> bool:
    if is_base_master(job):
        return True
    return (
        job.kind == KIND_WHOLE_FILM
        and job.operation == OPERATION_RENDER
        and job.status == STATUS_COMPLETED
        and job.output.url is not None
    )


def _enhanced_to(job: GenerationJob) -> VideoEnhanceResolution | None:
    return job.request.resolution if isinstance(job.request, VideoEnhanceRequest) else None


_RESOLUTION = re.compile(r"(\d+)p")


def _short_edge_of(resolution: str | None) -> int | None:
    if resolution is None:
        return None
    matched = _RESOLUTION.fullmatch(resolution.strip().lower())
    return None if matched is None else int(matched.group(1))


def _check_within_take(
    spans: Sequence[DubbingLine] | Sequence[DubbingSpeechSpan], video_ms: int, *, what: str
) -> None:
    # 都已按开始时间排好、互不重叠，核对最后一个就够了；`what` 是「第 N」后面的说法。
    position, last = len(spans), spans[-1]
    if last.start_ms >= video_ms:
        raise ValidationFailed(
            f"第 {position} {what}的开始 {format_seconds(last.start_ms / 1000)} 秒不在素材片之内，"
            f"素材片只有 {format_seconds(video_ms / 1000)} 秒"
        )
    if exceeds_source(last.end_ms, video_ms):
        raise ValidationFailed(
            f"第 {position} {what}的结尾 {format_seconds(last.end_ms / 1000)} 秒超出了素材片的时长 "
            f"{format_seconds(video_ms / 1000)} 秒"
        )


def _check_edit_range(start_ms: int, end_ms: int, base_ms: int) -> None:
    if start_ms >= base_ms:
        raise ValidationFailed(
            f"区间起点 {format_seconds(start_ms / 1000)} 秒不在基底之内，"
            f"基底只有 {format_seconds(base_ms / 1000)} 秒"
        )
    if exceeds_source(end_ms, base_ms):
        raise ValidationFailed(
            f"区间终点 {format_seconds(end_ms / 1000)} 秒超出了基底的时长 "
            f"{format_seconds(base_ms / 1000)} 秒"
        )


def _pending_job(
    request: GenerationRequest,
    *,
    owner_user_id: uuid.UUID,
    api_key_id: uuid.UUID | None,
    provider: str,
    conversation_id: uuid.UUID | None,
    task_id: uuid.UUID | None,
    metadata: dict[str, Any] | None,
    shot_index: int | None,
    root_job_id: uuid.UUID | None = None,
    source_job_id: uuid.UUID | None = None,
    model_group: str | None = None,
    upstream_model: str | None = None,
) -> GenerationJob:
    now = datetime.now(UTC)
    return GenerationJob(
        id=uuid.uuid4(),
        owner_user_id=owner_user_id,
        api_key_id=api_key_id,
        conversation_id=conversation_id,
        metadata=metadata,
        task_id=task_id,
        shot_index=shot_index,
        root_job_id=root_job_id,
        source_job_id=source_job_id,
        kind=request.kind,
        operation=request.operation,
        provider=provider,
        request=request,
        status=STATUS_PENDING,
        provider_task_id=None,
        provider_status=None,
        output=GenerationOutput(),
        error_code=None,
        error_message=None,
        created_at=now,
        submitted_at=None,
        finished_at=None,
        model_group=model_group,
        upstream_model=upstream_model,
    )


def _require_user_name(user_name: str | None) -> None:
    if user_name is None:
        raise ValidationFailed("user_name 必填")


class SettledRecords:
    def __init__(self, repo: GenerationRepository) -> None:
        self._repo = repo

    async def record_cuts(
        self, principal: Principal, grid_job_id: uuid.UUID, urls: Sequence[str]
    ) -> tuple[GenerationJob, ...]:
        grid = await self._repo.get(grid_job_id, owner=visible_owner_incl_act_as(principal))
        if not (
            grid.kind == KIND_IMAGE
            and grid.operation == OPERATION_GENERATE
            and grid.status == STATUS_COMPLETED
            and grid.output.url is not None
        ):
            raise RuntimeError(f"生成记录 {grid_job_id} 不是一张已完成的宫格，不能从它切图")
        return await self._repo.create_settled(
            [
                _settled_job(
                    principal,
                    job_id=uuid.uuid4(),
                    kind=KIND_IMAGE,
                    operation=OPERATION_CUT,
                    url=url,
                    conversation_id=grid.conversation_id,
                    task_id=grid.task_id,
                    source_job_id=grid.id,
                )
                for url in urls
            ]
        )


def _settled_job(
    principal: Principal,
    *,
    job_id: uuid.UUID,
    kind: GenerationKind,
    operation: GenerationOperation,
    url: str,
    conversation_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    source_job_id: uuid.UUID | None = None,
) -> GenerationJob:
    now = datetime.now(UTC)
    return GenerationJob(
        id=job_id,
        owner_user_id=principal.user_id,
        api_key_id=principal.api_key_id,
        conversation_id=conversation_id,
        task_id=task_id,
        source_job_id=source_job_id,
        kind=kind,
        operation=operation,
        provider=None,
        request=None,
        status=STATUS_COMPLETED,
        provider_task_id=None,
        provider_status=None,
        output=GenerationOutput(url=url),
        error_code=None,
        error_message=None,
        created_at=now,
        submitted_at=None,
        finished_at=now,
    )


__all__ = [
    "ClearCompletion",
    "EnhanceTier",
    "GenerationService",
    "ProviderTarget",
    "SettledRecords",
    "VideoEnhanceSpec",
    "VideoEnhancements",
]
