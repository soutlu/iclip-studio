"""媒体生成用例。受理请求时校验、保存 pending 记录并排队，Provider 调用由后台执行；创建即完成的
上传与切图记录另由 ``SettledRecords`` 直接落库。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Protocol

import structlog

from iclip.common.errors import NotFound, ValidationFailed
from iclip.common.shot_prompt import format_seconds
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_PENDING,
    GenerationJob,
    InFlightPhase,
    Inheritance,
    inherited_through,
)
from iclip.domains.generation.provider import ImageModelSpec
from iclip.domains.generation.queue import GenerationQueue
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_IMAGE,
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_GENERATE,
    OPERATION_UPLOAD,
    ComposeSegment,
    GenerationKind,
    GenerationOperation,
    GenerationRequest,
    ImageGenerationIn,
    VideoComposeIn,
    VideoComposeRequest,
    VideoEditIn,
    VideoGenerationIn,
)
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as
from iclip.platform.media.ffmpeg import MediaError
from iclip.platform.paging import check_limit

_logger = structlog.stdlib.get_logger(__name__)

ClearCompletion = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""按 (对话 id, 属主) 取消那段对话的收尾标记；实现由组合根注入，本域不认识对话表。"""

ProbeDuration = Callable[[str], Awaitable[int]]
"""按地址探一条远程视频的时长（毫秒），读不到或看不懂抛 ``MediaError``；实现由装配注入。"""


class ConversationLineage(Protocol):
    """按对话读记录时要知道的两件对话事实；实现由组合根接到对话域上，本域不认识对话表。"""

    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance:
        """这段对话的继承边界对，近的祖先在前；不是分叉来的给空。祖先删没删都照走。"""
        ...

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        """主体读不读得到这段对话，与对话域读路径同一口径。"""
        ...


class GenerationService:
    """生成请求受理与记录查询。"""

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
        probe_duration_ms: ProbeDuration,
    ) -> None:
        """收下装配期确定的模型集合；此层不持有或调用 Provider 实例。

        图片可选哪几家由装配表决定，本层只按它校验并把选中的那家写进记录。``probe_duration_ms``
        只在受理编辑段时用：核对参考片段与基底的时长。"""

        self._repo = repo
        self._queue = queue
        self._video_provider_name = video_provider_name
        self._compose_provider_name = compose_provider_name
        self._video_default_model = video_default_model
        self._video_allowed_models = video_allowed_models
        self._image_models = image_models
        self._image_default_model = image_default_model
        self._clear_completion = clear_completion
        self._lineage = lineage
        self._probe_duration_ms = probe_duration_ms

    async def _inheritance(
        self, principal: Principal, conversation_id: uuid.UUID | None
    ) -> Inheritance:
        """主体读得到这段对话时，它经分叉继承的边界对；没给对话或读不到就是空，只剩属主口径。

        读不到不报错：生成记录的对话归属只是标签，按对话列记录从来不要求读得到那段对话。"""

        if conversation_id is None or not await self._lineage.readable(principal, conversation_id):
            return ()
        return await self._lineage.ancestry(conversation_id)

    async def submit_video(self, principal: Principal, request: VideoGenerationIn) -> GenerationJob:
        """受理一次视频生成。模型必须在允许表里；其余字段原样转发给上游，由它按模型判。"""

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
        """受理一次编辑段：一次上游视频请求，参考片段由调用方切好、上传好。

        同步核对三件事，不合格不入队：基底是这段对话看得到的一条已完成成片，区间在它的时长之内；
        参考片段是调用者本人的一条视频上传；片段时长与区间长度一致。原作与镜号随基底，基底是出片
        就是它自己。区间原样记，不改写；片段地址记进落库的请求，原样转发上游。"""

        self._require_video_model(request.model)
        _require_user_name(request.user_name)
        base = await self._check_source(principal, request.source_job_id, request.conversation_id)
        if not _is_completed_master(base):
            raise ValidationFailed("基底必须是一条已完成的成片")
        (clip_url,) = request.reference_video_urls
        # 先认上传行再去探：探的是我们桶里、本人传上来的那一条，不替调用方去读任意地址。
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
            base_ms = await self._probe(base.output_url, what="基底", job_id=base.id)
        _check_edit_range(request.range_start_ms, request.range_end_ms, base_ms)
        clip_ms = await self._probe(clip_url, what="参考片段", job_id=clip.id)
        range_ms = request.range_end_ms - request.range_start_ms
        if abs(clip_ms - range_ms) > EDIT_CLIP_TOLERANCE_MS:
            raise ValidationFailed(
                f"参考片段长 {format_seconds(clip_ms / 1000)} 秒，"
                f"与区间长度 {format_seconds(range_ms / 1000)} 秒对不上"
            )
        forwarded = VideoGenerationIn(
            model=request.model,
            prompt=request.prompt,
            user_name=request.user_name,
            reference_image_urls=request.reference_image_urls,
            reference_video_urls=request.reference_video_urls,
            seconds=request.seconds,
            provider_options=request.provider_options,
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
        """受理一次合成：在基底那一版上按调用方给的片段列表拼成一条新成片，不经外部服务。

        来源记基底，原作与镜号随基底（基底是出片就是它自己）。每段出自基底本身，或来源是该基底的
        一条已完成编辑段，都要是这段对话自己的或继承来的；服务端把出处换成那条记录的产物地址，
        不收调用方给的地址。那条记录量过时长时，段的结尾不能超出它；没量过就交给执行方按下载
        下来的素材判。"""

        _require_user_name(request.user_name)
        base = await self._check_source(principal, request.base_job_id, request.conversation_id)
        if not _is_completed_master(base):
            raise ValidationFailed("基底必须是一条已完成的成片")
        sources = {base.id: base}
        for source_id in dict.fromkeys(segment.source_job_id for segment in request.segments):
            if source_id in sources:
                continue
            edit = await self._check_source(principal, source_id, request.conversation_id)
            if not _is_finished_edit(edit) or edit.source_job_id != base.id:
                raise ValidationFailed("每段必须出自基底本身，或基于这个基底的一条已完成编辑段")
            sources[source_id] = edit
        segments: list[ComposeSegment] = []
        for position, segment in enumerate(request.segments, start=1):
            source = sources[segment.source_job_id]
            # 两种来源都在上面核过产物地址，这里只为收窄类型。
            if source.output_url is None:
                raise RuntimeError(f"生成记录 {source.id} 核对过却没有产物地址")
            _check_segment_end(position, segment.end, source.duration_ms)
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
        """来源必须是这段对话自己的或它继承的一条记录，返回那条记录。

        先按主体可见范围读：生成记录的 ``conversation_id`` 只是标签、不按对话验属主，直接按
        id 查会让人在别人的片上接着剪；继承的那部分只在主体读得到这段对话时才算。按属主读得到
        的也可能是祖先对话里分叉之后才完成的，那不归这段对话，要再判一次。不存在、不可见、
        不在范围内给同一句，不区分存在性；角色与状态对不对由调用方判。"""

        inheritance = await self._inheritance(principal, conversation_id)
        try:
            source = await self._repo.get(
                source_id, owner=visible_owner_incl_act_as(principal), inherited=inheritance
            )
        except NotFound:
            source = None
        if source is None or (
            source.conversation_id != conversation_id and not inherited_through(source, inheritance)
        ):
            raise ValidationFailed("来源不是这段对话自己的或继承来的一条记录")
        return source

    async def _probe(self, url: str | None, *, what: str, job_id: uuid.UUID) -> int:
        """探 ``what``（那条记录 ``job_id`` 的产物 ``url``）有多长，毫秒。

        探不出来也是不受理，但措辞与「时长对不上」分开：多半是取不到，不是调用方给错了。"""

        if url is None:
            # 两处调用方都先核过这条有产物地址，这里只为收窄类型。
            raise RuntimeError(f"生成记录 {job_id} 核对过却没有产物地址")
        try:
            return await self._probe_duration_ms(url)
        except MediaError as exc:
            _logger.warning("编辑段受理时探不出时长", what=what, job_id=job_id, error=str(exc))
            raise ValidationFailed(f"读不出{what}的时长，请稍后重试") from exc

    def _require_video_model(self, model: str) -> None:
        if model not in self._video_allowed_models:
            raise ValidationFailed(f"视频生成仅支持模型 {'、'.join(self._video_allowed_models)}")

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        """受理一次图片生成。选定哪家、哪个渠道在这里定死，队列等待期间的配置变化不影响它。

        帧图编辑带着底图地址 ``source_url``，来源在这里定下（见 ``_resolve_base``）。"""

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
            # 图片的镜与帧只有分镜页自己用来找格子，是调用方的 metadata，不落镜号列。
            shot_index=None,
            source_job_id=base_id,
            source_url=external,
        )

    async def find_conversation_image(
        self, principal: Principal, url: str, conversation_id: uuid.UUID
    ) -> GenerationJob | None:
        """这个地址是不是这段对话里一张已完成的图片：对话自己的，或它经分叉继承来的。

        生成、帧图编辑与切图都算；上传不属于任何对话，不在这里认。找不到返回 None。"""

        return await self._repo.find_by_output(
            url,
            kind=KIND_IMAGE,
            owner=visible_owner_incl_act_as(principal),
            conversation_id=conversation_id,
            inherited=await self._inheritance(principal, conversation_id),
        )

    async def find_upload(self, principal: Principal, url: str) -> GenerationJob | None:
        """主体看得见的一条图片上传记录，产物就是这个地址；找不到返回 None。

        上传不属于任何对话，只按主体可见范围认。"""

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
        """帧图编辑的底图是库里哪一行：先找这段对话自己的与它继承来的图片，再找主体可见的上传。

        找到返回 ``(那一行的 id, None)``；找不到就是外部底图 ``(None, 地址)``，不报错。没给地址两者
        都空。上传不属于任何对话，不受对话范围限制，只按主体可见范围认。"""

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
        """保存 pending 记录并排队。入库与排队分属不同事务，排队失败时标记失败并抛出错误。

        kind 与 operation 随落库请求的类型定；归属、镜号、来源与区间由各入口显式给，不从请求上抄。
        镜号没有默认值：漏传就会静默落成一条没有镜号的记录。帧图编辑的两种来源恰好一个，由
        ``_resolve_base`` 保证。两步之间进程中断会留下未排队的 pending 记录，需要人工确认后重新发起。"""

        now = datetime.now(UTC)
        job = GenerationJob(
            id=uuid.uuid4(),
            owner_user_id=principal.user_id,
            api_key_id=principal.api_key_id,
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
            # 仓储使用数据库 now() 覆盖时间占位值。
            created_at=now,
            submitted_at=None,
            finished_at=None,
        )
        created = await self._repo.create(job)
        try:
            await self._queue.enqueue_submit(created)
        except Exception as exc:
            await self._repo.mark_failed(
                created.id,
                error_code="QUEUE_DEFER_FAILED",
                error_message=f"受理了但没能排进队列，请重新发起：{exc}",
            )
            _logger.exception("生成任务排队失败", job_id=created.id)
            raise
        await self._note_conversation_active(created)
        return created

    async def _note_conversation_active(self, job: GenerationJob) -> None:
        """出片提交就是又在这段对话里开工了，收尾标记不该留着。

        归档标签指向的对话不校验，对话域按属主自己判；这一步失败只记日志——受理已经成立，
        不能因为一个标记回滚。"""

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
        """把这次要用哪家、哪个渠道定下来写进请求，并把选定的那家单独交回去当 provider 列。

        画幅与分辨率的全局枚举是各家的并集，各家真正支持的范围由它自己声明；在这里拦，
        才不会变成一次已排队、已付费的失败。"""

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
        # 受理时固定，队列等待期间的配置变化不能改变这次请求的选择。
        channel = request.channel or (spec.channels[0] if spec.channels else None)
        return request.model_copy(update={"model": model, "channel": channel}), model

    def video_models(self) -> tuple[str, tuple[str, ...]]:
        """默认视频模型与允许表，按配置声明顺序。"""

        return self._video_default_model, self._video_allowed_models

    def image_models(self) -> tuple[str, tuple[tuple[str, ImageModelSpec], ...]]:
        """默认模型与装配表里那几家的声明，按声明顺序。"""

        return self._image_default_model, tuple(self._image_models.items())

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        """读取可见生成记录，不可见时返回 NotFound。"""

        return await self._repo.get(job_id, owner=visible_owner_incl_act_as(principal))

    async def source_addresses(self, jobs: Sequence[GenerationJob]) -> Mapping[uuid.UUID, str]:
        """每条记录来源的地址，按记录 id 给：库内来源取那一条的产物地址，外部底图就是记下的地址；
        没有来源的不在结果里。

        来源那一条不再按主体判可见：记录本身可见，它记着的来源地址就照给（继承来的帧图编辑，底图
        可能是祖先属主的上传，按 id 单条读不到）。"""

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
        """视频任务查询只认调上游的视频记录（出片与编辑段）：图片、合成与视频上传的 id 与不存在同样是 404。

        合成不经上游、没有水印版地址，套不进上游任务查询的形状。"""

        job = await self.get(principal, job_id)
        if job.kind != KIND_VIDEO or job.operation != OPERATION_GENERATE:
            raise NotFound(f"没有这个视频任务: {job_id}")
        return job

    async def in_flight_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID], *, kind: GenerationKind
    ) -> Mapping[uuid.UUID, InFlightPhase]:
        """给对话侧栏用：这些对话下还没跑完的某类任务各到哪一步。可见性由对话那边判过，这里不再按属主筛。"""

        return await self._repo.in_flight_by_conversation(conversation_ids, kind=kind)

    async def latest_master_by_conversation(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, str]:
        """给对话审计列表用：这些对话各自名下最新一条成片的地址，不含继承来的。可见性同上。"""

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
        """按时间倒序返回可见记录；归属筛选只收窄，不扩大属主可见范围。

        唯一的例外是按对话列：主体读得到那段对话时，连它经分叉继承的记录一起列出，不看属主。"""

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


def _is_completed_master(job: GenerationJob) -> bool:
    """成片：一条已完成、有地址的视频，是出片（没有来源的 generate）或合成。"""

    return (
        job.kind == KIND_VIDEO
        and job.status == STATUS_COMPLETED
        and job.output_url is not None
        and (
            job.operation == OPERATION_COMPOSE
            or (job.operation == OPERATION_GENERATE and job.source_job_id is None)
        )
    )


def _is_finished_edit(job: GenerationJob) -> bool:
    """已完成、有产物地址的编辑段：有来源的视频 generate。"""

    return (
        job.kind == KIND_VIDEO
        and job.operation == OPERATION_GENERATE
        and job.source_job_id is not None
        and job.status == STATUS_COMPLETED
        and job.output_url is not None
    )


COMPOSE_END_TOLERANCE_MS: Final = 50
"""合成里段的结尾、编辑段区间的终点，最多比那条记录（基底）量出来的时长多出这么多毫秒。

调用方的起止是浏览器里读到的媒体时间（播放器时长、关键帧时刻），与上游或 ffprobe 量出的
``duration_ms`` 隔着一次容器时长的取整，差不到一帧（24fps 约 42 毫秒）；严格相等会把正常的
「取到最后一帧」拒掉。"""


def _check_segment_end(position: int, end: float | None, duration_ms: int | None) -> None:
    """第 ``position`` 段（从 1 数）的结尾不能超出那条记录的时长；开放的结尾或没量过时长的不判。"""

    if end is None or duration_ms is None:
        return
    if end * 1000 > duration_ms + COMPOSE_END_TOLERANCE_MS:
        raise ValidationFailed(
            f"第 {position} 段的结尾 {format_seconds(end)} 秒超出了那条记录的时长 "
            f"{format_seconds(duration_ms / 1000)} 秒"
        )


EDIT_CLIP_TOLERANCE_MS: Final = 100
"""参考片段的时长最多与区间长度差这么多毫秒。

片段是浏览器从基底上按关键帧重封装出来的，容器时长取各轨结尾里最晚的那个，会被音轨尾巴拉长：
技术验证里比视频轨长约 16 毫秒。再留出一帧以上的余量（24fps 一帧约 42 毫秒），严格相等会把
正常切出的片段拒掉，差得更多才说明片段与区间不是同一段。"""


def _check_edit_range(start_ms: int, end_ms: int, base_ms: int) -> None:
    """编辑区间要在基底之内：起点严格落在基底里，终点不超过基底时长。

    终点取到片尾时是浏览器读到的媒体时长，与上游或 ffprobe 量出的隔着一次容器时长的取整，容差
    与合成各段的结尾同一个（``COMPOSE_END_TOLERANCE_MS``）。"""

    if start_ms >= base_ms:
        raise ValidationFailed(
            f"区间起点 {format_seconds(start_ms / 1000)} 秒不在基底之内，"
            f"基底只有 {format_seconds(base_ms / 1000)} 秒"
        )
    if end_ms > base_ms + COMPOSE_END_TOLERANCE_MS:
        raise ValidationFailed(
            f"区间终点 {format_seconds(end_ms / 1000)} 秒超出了基底的时长 "
            f"{format_seconds(base_ms / 1000)} 秒"
        )


def _require_user_name(user_name: str | None) -> None:
    """HTTP 边界与工具都先按主体定好了名字；到这儿还空着就是漏了一条路，照实拒绝。"""

    if user_name is None:
        raise ValidationFailed("user_name 必填")


@dataclass(frozen=True, slots=True)
class UploadRecord:
    """一条上传记录交回的地址，以及这个地址上的对象是哪一次上传传上来的。"""

    url: str
    object_upload_id: uuid.UUID
    """对象 key 里的 uploadId：记了 MD5 的是同一个 MD5 最早那条视频上传的 id（去重后是先传的那一次），
    没记的就是这一行自己的 id。"""


class SettledRecords:
    """创建即完成的两种记录：上传与切图。只要仓储，不经队列，媒体生成没开也能落上传行。"""

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
    ) -> UploadRecord:
        """记一条上传：行 id 就是 ``upload_id``，属主与钥匙取 ``principal``，不挂对话，没有来源与请求。

        给了 ``content_md5``（只有视频）就照记，并且同一个 MD5 已有视频上传时，这一行的地址落最早
        那条的地址，不落 ``url``。交回这一行最终的地址。

        按 ``upload_id`` 幂等：已经记过就不动它，第二次确认换了主体属主也照旧，交回已有那行的地址；
        同一个 id 却不是上传，说明 id 撞了，抛 ``RuntimeError``。"""

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
        """这次上传记过没有：记过交回那一行的地址，没记过给 ``None``。不按属主过滤，同确认本身；
        同一个 id 却不是上传，抛 ``RuntimeError``。"""

        try:
            job = await self._repo.get(upload_id, owner=None)
        except NotFound:
            return None
        return await self._upload_record(job)

    async def _upload_record(self, job: GenerationJob) -> UploadRecord:
        """已落库的一行上传：记了 MD5 的，对象归同一个 MD5 最早那条视频上传（去重时抄的就是它的
        地址）；没记 MD5 的地址就是它自己传上来的对象。"""

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
        """从这张宫格切出、已转存的几格各记一条切图，与 ``urls`` 同序、一个事务落：来源是宫格，
        对话与需求单抄宫格，属主与钥匙取 ``principal``（与宫格同一个运行主体）。

        宫格必须是主体读得到的、已完成、有产物的图片生成。工具刚等到它完成，对不上是装配或状态
        坏了，抛 ``RuntimeError``，不当成模型能改的输入。"""

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
    """一条创建即完成的记录。它们不进队列，``provider`` 只是标签，就写操作名；时刻由仓储改成
    数据库时钟。"""

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
    """创建即完成的行必有产物地址（库里由 ``ck_generation_jobs_settled`` 兜底）。"""

    if job.output_url is None:
        raise RuntimeError(f"记录 {job.id} 创建即完成却没有产物地址")
    return job.output_url


__all__ = [
    "ConversationLineage",
    "GenerationService",
    "ProbeDuration",
    "SettledRecords",
    "UploadRecord",
]
