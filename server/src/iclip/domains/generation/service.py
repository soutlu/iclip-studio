from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.common.shot_prompt import format_seconds
from iclip.domains.generation.clip_models import UpstreamMode, clip_model
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    InFlightPhase,
    Inheritance,
    is_base_master,
    is_finished_edit,
)
from iclip.domains.generation.ports import ConversationLineage, RemoteMediaProbe
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
    OPERATION_UPLOAD,
    ComposeSegment,
    GenerationKind,
    GenerationOperation,
    GenerationStatus,
    ImageGenerationIn,
    MusicIn,
    MusicRequest,
    SubtitleIn,
    SubtitleRequest,
    VideoComposeIn,
    VideoComposeRequest,
    VideoEditIn,
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

# 网关调度：不带参考音视频时 1 张图作首帧、2 张依次作首尾帧，更多才作参考图（multiflow docs/api.md）。
_MAX_FIRST_FRAMES = 2
_CONCRETE_RATIO = re.compile(r"\d+(\.\d+)?:\d+(\.\d+)?")


@dataclass(frozen=True, slots=True)
class ProviderTarget:
    provider: str
    model: str


@dataclass(frozen=True, slots=True)
class VideoEnhanceSpec:
    """高清版的运行配置：用哪个模型、配了哪几档（从高到低）、目标帧率（为空不插帧）。"""

    model: str
    resolutions: tuple[VideoEnhanceResolution, ...]
    fps: int | None


@dataclass(frozen=True, slots=True)
class EnhanceTier:
    """一条视频能做的一档高清版，与这一档最近的一条超分记录（谁提的都算），还没有为空。"""

    resolution: VideoEnhanceResolution
    job: GenerationJob | None


@dataclass(frozen=True, slots=True)
class VideoEnhancements:
    downloaded_job_ids: tuple[uuid.UUID, ...]
    """下载高清版时记下载事件的素材片：视频是它自己，成片是它导出时用到的各条。"""
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
        subtitles: ProviderTarget | None = None,
        music: ProviderTarget | None = None,
        render: RenderClient | None = None,
        enhance: VideoEnhanceSpec | None = None,
    ) -> None:
        self._repo = repo
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
        self._subtitles = subtitles
        self._music = music

    async def _inheritance(
        self, principal: Principal, conversation_id: uuid.UUID | None
    ) -> Inheritance:
        if conversation_id is None or not await self._lineage.readable(principal, conversation_id):
            return ()
        return await self._lineage.ancestry(conversation_id)

    async def submit_video(self, principal: Principal, request: VideoGenerationIn) -> GenerationJob:
        self._require_video_model(request.model)
        _require_user_name(request.user_name)
        return await self._accept(
            principal,
            request,
            provider=self._video_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=request.shot_index,
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
        clip = None
        if request.reference_video_urls:
            (clip_url,) = request.reference_video_urls
            clip = await self._repo.find_by_output(
                clip_url,
                kind=KIND_VIDEO,
                owner=principal.user_id,
                conversation_id=None,
                operation=OPERATION_UPLOAD,
            )
            if clip is None:
                raise ValidationFailed("reference_video_urls 必须是调用者本人上传的一段视频")
        base_ms = base.duration_ms
        if base_ms is None:
            base_ms = await self._probe_duration(base.output_url, what="基底", job_id=base.id)
        _check_edit_range(request.range_start_ms, request.range_end_ms, base_ms)
        if clip is not None and spec.edit is not None:
            clip_ms = await self._probe_duration(clip.output_url, what="参考片段", job_id=clip.id)
            if not spec.edit.min_seconds * 1000 <= clip_ms <= spec.edit.max_seconds * 1000:
                raise ValidationFailed(
                    f"{request.model} 编辑参考时长必须为 "
                    f"{spec.edit.min_seconds}–{spec.edit.max_seconds} 秒"
                )
        forwarded = VideoGenerationIn(
            model=request.model,
            prompt=upstream.prompt(request.prompt),
            user_name=request.user_name,
            reference_image_urls=request.reference_image_urls,
            reference_video_urls=request.reference_video_urls,
            aspect_ratio=aspect_ratio,
            seconds=request.seconds,
            provider_options=options,
        )
        return await self._accept(
            principal,
            forwarded,
            provider=self._video_provider_name,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=base.shot_index,
            root_job_id=base.root_job_id or base.id,
            source_job_id=base.id,
            range_start_ms=request.range_start_ms,
            range_end_ms=request.range_end_ms,
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
            if source.output_url is None:
                raise RuntimeError(f"生成记录 {source.id} 核对过却没有产物地址")
            if segment.end is not None:
                check_segment_end(position, round(segment.end * 1000), source.duration_ms)
            segments.append(
                ComposeSegment(
                    source_job_id=source.id,
                    url=source.output_url,
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
        """原作出片请求里的画幅：参考图生成不给比例时网关按素材自适应，要与原片同画幅只能明说。
        原作没记具体比例就拒，不让画幅悄悄跟着素材走。"""

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

    async def _probe_duration(self, url: str | None, *, what: str, job_id: uuid.UUID) -> int:
        if url is None:
            raise RuntimeError(f"生成记录 {job_id} 核对过却没有产物地址")
        try:
            return await self._media_probe.duration_ms(url)
        except MediaError as exc:
            _logger.warning("编辑段受理时探不出时长", what=what, job_id=job_id, error=str(exc))
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
            settled,
            provider=model,
            conversation_id=request.conversation_id,
            task_id=request.task_id,
            metadata=request.metadata,
            shot_index=None,
            source_job_id=base_id,
            source_url=external,
        )

    async def find_conversation_image(
        self, principal: Principal, url: str, conversation_id: uuid.UUID
    ) -> GenerationJob | None:
        return await self._repo.find_by_output(
            url,
            kind=KIND_IMAGE,
            owner=visible_owner_incl_act_as(principal),
            conversation_id=conversation_id,
            inherited=await self._inheritance(principal, conversation_id),
        )

    async def find_upload(self, principal: Principal, url: str) -> GenerationJob | None:
        return await self._repo.find_by_output(
            url,
            kind=KIND_IMAGE,
            owner=visible_owner_incl_act_as(principal),
            conversation_id=None,
            operation=OPERATION_UPLOAD,
        )

    async def _resolve_base(
        self, principal: Principal, url: str | None, conversation_id: uuid.UUID | None
    ) -> tuple[uuid.UUID | None, str | None]:
        if url is None:
            return None, None
        owner = visible_owner_incl_act_as(principal)
        found = await self._repo.find_by_output(
            url,
            kind=KIND_IMAGE,
            owner=owner,
            conversation_id=conversation_id,
            inherited=await self._inheritance(principal, conversation_id),
        )
        if found is None:
            found = await self.find_upload(principal, url)
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
        source_url: str | None = None,
        range_start_ms: int | None = None,
        range_end_ms: int | None = None,
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
                source_url=source_url,
                range_start_ms=range_start_ms,
                range_end_ms=range_end_ms,
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

    async def submit_subtitle(self, principal: Principal, request: SubtitleIn) -> GenerationJob:
        subtitles = self._require_subtitles()
        video = await conversation_record(
            self._repo,
            principal,
            request.source_job_id,
            conversation_id=request.conversation_id,
            inheritance=await self._inheritance(principal, request.conversation_id),
        )
        if video is None:
            raise NotFound(f"没有这次生成: {request.source_job_id}")
        if not is_base_master(video) or video.output_url is None:
            raise ValidationFailed("只能识别素材片：已完成的出片或合成")
        return await self._queue_new(
            _pending_job(
                SubtitleRequest(model=subtitles.model, video_url=video.output_url),
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                provider=subtitles.provider,
                conversation_id=request.conversation_id,
                task_id=request.task_id,
                metadata=request.metadata,
                shot_index=None,
                source_job_id=video.id,
            )
        )

    async def transcribe_completed(self, job: GenerationJob) -> None:
        if self._subtitles is None or not is_base_master(job) or job.output_url is None:
            return
        await self._queue_new(
            _pending_job(
                SubtitleRequest(model=self._subtitles.model, video_url=job.output_url),
                owner_user_id=job.owner_user_id,
                api_key_id=job.api_key_id,
                provider=self._subtitles.provider,
                conversation_id=job.conversation_id,
                task_id=job.task_id,
                metadata=None,
                shot_index=None,
                source_job_id=job.id,
            )
        )

    def _require_subtitles(self) -> ProviderTarget:
        if self._subtitles is None:
            raise ValidationFailed("字幕识别没有开通，暂时不能识别")
        return self._subtitles

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
            )
        )

    async def submit_whole_film(
        self, principal: Principal, *, conversation_id: uuid.UUID, request: WholeFilmRequest
    ) -> GenerationJob:
        """把一次成片导出记成一条生成记录、排进渲染服务那条队列。

        归属与对话由调用方核对过。导出不是动手创作，不抹对话的收尾标记。"""

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
        """取消一次成片导出，记为失败、错误码 ``CANCELLED``；调用方已核对归属。

        还在排队就直接记；正在交给渲染服务答 409；已交出去的先让渲染服务取消（它查不到也行）再记，
        渲染服务连不上抛 ``RenderUnavailable``、记录不动；已有结论的不改。"""

        render = self._require_render()
        if job.status == STATUS_PENDING:
            if await self._mark_cancelled(job.id, only_if_status=STATUS_PENDING) is not None:
                return
            # 读到排队之后队列已经接手，按它现在的状态再判一次；不会再回到排队。
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
        """给一条素材片或一条导出完成的成片提一档高清版，记一条超分记录、排进视频那条队列。

        来源不按属主取：资料库里全站的片谁都看得到、下载得到，高清版也一样。同一来源同一档已有
        没失败的超分记录（谁提的都算），直接给那一条，不新建、不排队；失败的可以重做。超分记录
        不挂对话、没有原作，镜号抄来源；产出的总是一个视频，种类一律是视频。"""

        enhance = self._require_enhance()
        source = await self._repo.get(request.source_job_id, owner=None)
        if not _enhanceable(source) or source.output_url is None:
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
        return await self._queue_new(
            _pending_job(
                VideoEnhanceRequest(
                    model=enhance.model,
                    resolution=request.resolution,
                    fps=enhance.fps,
                    video_url=source.output_url,
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
            )
        )

    async def enhancements(self, job_id: uuid.UUID) -> VideoEnhancements:
        """一条视频能做的高清版各档与各档最近的一条超分记录。来源不按属主取，不存在抛 ``NotFound``；
        来源做不了高清版时两项都空，高清版没开通时没有档。"""

        source = await self._repo.get(job_id, owner=None)
        if not _enhanceable(source):
            return VideoEnhancements(downloaded_job_ids=(), tiers=())
        downloaded = _downloaded_with(source)
        if self._enhance is None:
            return VideoEnhancements(downloaded_job_ids=downloaded, tiers=())
        latest: dict[VideoEnhanceResolution, GenerationJob] = {}
        # 新建的在前，每档取第一条就是最近的那条。
        for job in await self._repo.enhancements_of(source.id):
            resolution = _enhanced_to(job)
            if resolution is not None:
                latest.setdefault(resolution, job)
        return VideoEnhancements(
            downloaded_job_ids=downloaded,
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
        """配置的档里比来源清晰的那几档（按短边比），保持配置的先后；来源清晰度推不出来就全给，
        由上游去拒。"""

        edge = await self._short_edge(source)
        return tuple(
            resolution
            for resolution in enhance.resolutions
            if edge is None or (_short_edge_of(resolution) or 0) > edge
        )

    async def _short_edge(self, source: GenerationJob) -> int | None:
        """来源的短边像素，按出片请求里的分辨率推，不探测文件：合成取原作的，成片取画面轨第一条
        素材片的。推不出来是 ``None``。"""

        video = source
        if video.kind == KIND_WHOLE_FILM:
            if not isinstance(video.request, WholeFilmRequest) or not video.request.videos:
                return None
            first = await self._find(video.request.videos[0].job_id)
            if first is None or not is_base_master(first):
                return None
            video = first
        if video.operation == OPERATION_COMPOSE:
            if video.root_job_id is None:
                return None
            root = await self._find(video.root_job_id)
            if root is None:
                return None
            video = root
        if not isinstance(video.request, VideoGenerationIn):
            return None
        return _short_edge_of(video.request.resolution)

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
            if job.source_url is not None:
                addresses[job.id] = job.source_url
            elif job.source_job_id is not None and job.source_job_id in outputs:
                addresses[job.id] = outputs[job.source_job_id]
        return addresses

    async def get_video(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        job = await self.get(principal, job_id)
        if job.kind != KIND_VIDEO or job.operation != OPERATION_GENERATE:
            raise NotFound(f"没有这个视频任务: {job_id}")
        return job

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        return await self._repo.in_flight_by_conversation(conversation_ids, kind=kind)

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
    """能做高清版的来源：一条素材片，或一条导出完成、有地址的成片。"""

    if is_base_master(job):
        return True
    return (
        job.kind == KIND_WHOLE_FILM
        and job.operation == OPERATION_RENDER
        and job.status == STATUS_COMPLETED
        and job.output_url is not None
    )


def _downloaded_with(source: GenerationJob) -> tuple[uuid.UUID, ...]:
    """下载这条来源的高清版时记下载事件的素材片，口径同下载来源本身。"""

    if isinstance(source.request, WholeFilmRequest):
        return tuple(video.job_id for video in source.request.videos)
    return (source.id,)


def _enhanced_to(job: GenerationJob) -> VideoEnhanceResolution | None:
    return job.request.resolution if isinstance(job.request, VideoEnhanceRequest) else None


_RESOLUTION = re.compile(r"(\d+)p")


def _short_edge_of(resolution: str | None) -> int | None:
    """``720p`` 这样的档位写法的短边像素；别的写法认不出，是 ``None``。"""

    if resolution is None:
        return None
    matched = _RESOLUTION.fullmatch(resolution.strip().lower())
    return None if matched is None else int(matched.group(1))


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
    source_url: str | None = None,
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
) -> GenerationJob:
    """一条刚受理、还在排队的记录，种类与操作随请求类型定。"""

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
        source_url=source_url,
        range_start_ms=range_start_ms,
        range_end_ms=range_end_ms,
        kind=request.kind,
        operation=request.operation,
        provider=provider,
        request=request,
        status=STATUS_PENDING,
        provider_task_id=None,
        provider_status=None,
        output_url=None,
        error_code=None,
        error_message=None,
        created_at=now,
        submitted_at=None,
        finished_at=None,
    )


def _require_user_name(user_name: str | None) -> None:
    if user_name is None:
        raise ValidationFailed("user_name 必填")


@dataclass(frozen=True, slots=True)
class UploadRecord:
    url: str
    object_upload_id: uuid.UUID


class SettledRecords:
    def __init__(self, repo: GenerationRepository) -> None:
        self._repo = repo

    async def record_upload(
        self,
        principal: Principal,
        *,
        upload_id: uuid.UUID,
        kind: GenerationKind,
        url: str,
        content_md5: str | None,
        conversation_id: uuid.UUID | None,
    ) -> UploadRecord:
        first = (
            None if content_md5 is None else await self._repo.find_video_upload_by_md5(content_md5)
        )
        created = await self._repo.create_settled(
            [
                _settled_job(
                    principal,
                    job_id=upload_id,
                    kind=kind,
                    operation=OPERATION_UPLOAD,
                    url=url if first is None else _settled_url(first),
                    conversation_id=conversation_id,
                    content_md5=content_md5,
                )
            ]
        )
        if created:
            (job,) = created
            return UploadRecord(
                url=_settled_url(job), object_upload_id=upload_id if first is None else first.id
            )
        return await self._upload_record(await self._repo.get(upload_id, owner=None))

    async def recorded_upload(self, upload_id: uuid.UUID) -> UploadRecord | None:
        try:
            job = await self._repo.get(upload_id, owner=None)
        except NotFound:
            return None
        return await self._upload_record(job)

    async def _upload_record(self, job: GenerationJob) -> UploadRecord:
        if job.operation != OPERATION_UPLOAD:
            raise RuntimeError(f"上传 {job.id} 撞上了一条 {job.kind} / {job.operation} 记录")
        url = _settled_url(job)
        if job.content_md5 is None:
            return UploadRecord(url=url, object_upload_id=job.id)
        first = await self._repo.find_video_upload_by_md5(job.content_md5)
        if first is None:
            raise RuntimeError(f"上传 {job.id} 按自己的 MD5 找不到视频上传记录")
        return UploadRecord(url=url, object_upload_id=first.id)

    async def record_cuts(
        self, principal: Principal, grid_job_id: uuid.UUID, urls: Sequence[str]
    ) -> tuple[GenerationJob, ...]:
        grid = await self._repo.get(grid_job_id, owner=visible_owner_incl_act_as(principal))
        if not (
            grid.kind == KIND_IMAGE
            and grid.operation == OPERATION_GENERATE
            and grid.status == STATUS_COMPLETED
            and grid.output_url is not None
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
    content_md5: str | None = None,
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
        provider=operation,
        request=None,
        status=STATUS_COMPLETED,
        provider_task_id=None,
        provider_status=None,
        output_url=url,
        error_code=None,
        error_message=None,
        created_at=now,
        submitted_at=None,
        finished_at=now,
        content_md5=content_md5,
    )


def _settled_url(job: GenerationJob) -> str:
    if job.output_url is None:
        raise RuntimeError(f"记录 {job.id} 创建即完成却没有产物地址")
    return job.output_url


__all__ = [
    "ClearCompletion",
    "EnhanceTier",
    "GenerationService",
    "ProviderTarget",
    "SettledRecords",
    "UploadRecord",
    "VideoEnhanceSpec",
    "VideoEnhancements",
]
