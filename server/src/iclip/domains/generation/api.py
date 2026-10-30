from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from agent_runtime.errors import ValidationFailed
from fastapi import APIRouter, Query
from pydantic import TypeAdapter, ValidationError

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import (
    GenerationEnvelope,
    GenerationKind,
    GenerationOperation,
    GenerationsPageOut,
    ImageGenerationIn,
    ImageModelOut,
    ImageModelsOut,
    Metadata,
    MusicIn,
    SubtitleIn,
    VideoComposeIn,
    VideoEditIn,
    VideoEnhanceIn,
    VideoEnhancementsOut,
    VideoEnhanceTierOut,
    VideoGenerationIn,
    VideoModelsOut,
    VideoSubmitOut,
    VideoTaskOut,
    generation_out,
    video_task_out,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import (
    ActAs,
    Principal,
    require_permission,
    resolve_user_name,
)
from iclip.platform.http import validation_error_detail
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_generations_router(service: GenerationService, *, act_as: ActAs) -> APIRouter:
    router = APIRouter(prefix="/generations")

    async def envelope(job: GenerationJob) -> GenerationEnvelope:
        addresses = await service.source_addresses([job])
        return GenerationEnvelope(
            generation=generation_out(job, source_address=addresses.get(job.id))
        )

    @router.post("/video", response_model=VideoSubmitOut, status_code=202)
    async def submit_video(
        body: VideoGenerationIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> VideoSubmitOut:
        """提交一次视频生成。请求体照上游异步接口，外加 conversation_id / task_id / shot_index /
        metadata。

        正文可以直接给 ``prompt``，也可以给结构化的 ``shot`` 由服务端拼成 ``prompt``；记录里
        两者都存，``shot`` 不发上游。``shot_index`` 是镜头组编号，落记录的列。``user_name``：
        API key 调用方必填、照收；浏览器会话可省略，填登录用户名。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return VideoSubmitOut(task_id=job.id)

    @router.post("/video-edits", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_edit(
        body: VideoEditIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """为素材片上的区间生成替换片段。参考视频为空时图生，有一条时编辑；模型与两种模式的时长
        能力由 video-models 声明。图生必须引用图片并指定整秒时长；编辑参考须为本人上传的视频，
        实测时长要满足模型限制，seconds 固定为 -1。不合格 422、不入队。

        source_job_id 与 range_start_ms / range_end_ms 记下基底与替换区间，使用基底媒体时间，
        独立于生成时长。基底须为本对话自己的或继承来的已完成素材片，区间须在其时长之内。
        user_name 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_edit(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return await envelope(job)

    @router.post("/video-composites", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_composite(
        body: VideoComposeIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """在基底那一版上按片段列表拼成一条新素材片，来源记基底，原作与镜号随基底。不经外部服务。

        ``baseJobId`` 必须是这段对话自己的或继承来的一条已完成素材片；``segments`` 每段的
        ``sourceJobId`` 是基底本身或来源是基底的一条已完成编辑段，``start`` / ``end`` 是那条记录
        自己的媒体时间（秒），``end`` 省略即取到结尾。服务端把出处换成地址，记进
        ``request.segments``。``userName`` 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_compose(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return await envelope(job)

    @router.post("/subtitles", response_model=GenerationEnvelope, status_code=202)
    async def submit_subtitle(
        body: SubtitleIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """手动识别一条素材片的口播，另起一条字幕记录（种类 ``subtitle``）；素材片完成时后台已自动识别
        一次，这里用来补识别旧视频或识别失败后重来。结果在记录的 ``sentences`` 里。

        ``sourceJobId`` 要是这段对话（``conversationId``）自己的或继承来的一条视频，读不到 404；读得到
        却不是素材片（已完成的出片或合成）422。字幕识别没开通 422。新记录的对话、需求单与 ``metadata``
        取请求；``userName`` 的规则同出片，只用来替人办事，不进 ``request``。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_subtitle(principal, body)
        return await envelope(job)

    @router.post("/video-enhancements", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_enhancement(
        body: VideoEnhanceIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """给一条素材片或一条导出完成的成片做一档高清版（超分），记一条超分记录（操作 ``enhance``，
        种类 ``video``）；完成后 ``outputUrl`` / ``watermarkOutputUrl`` 同出片。

        ``sourceJobId`` 不按属主取：资料库里看得到的片谁都能提。来源不存在 404；不是素材片或成片、
        ``resolution`` 不比来源清晰（可做的档见 ``GET /generations/{id}/enhancements``）、高清版没开通
        都是 422。同一来源同一档已有没失败的超分记录（谁提的都算）时直接给那一条，不新建。
        ``userName`` 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_enhance(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return await envelope(job)

    @router.post("/music", response_model=GenerationEnvelope, status_code=202)
    async def submit_music(
        body: MusicIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """生成一段背景音乐，记一条音频记录（种类 ``audio``、操作 ``generate``）；完成后
        ``outputUrl`` 是去掉首尾静音、统一响度后转存的 m4a，``durationMs`` 是它的时长。

        ``prompt`` 原样发给音乐模型，服务端不补任何文字，至多 3000 字。``conversationId`` 必填，
        读不到这段对话 404；生成背景音乐没开通 422。``userName`` 的规则同出片，只用来替人办事，
        不进 ``request``。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_music(principal, body)
        return await envelope(job)

    @router.post("/image", response_model=GenerationEnvelope, status_code=202)
    async def submit_image(
        body: ImageGenerationIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """提交一次图片生成。``userName`` 的规则与视频相同。

        帧图编辑带 ``sourceUrl``（底图地址）：先在本对话及它继承的图片里找，再找调用方可见的上传，
        找到记 ``sourceJobId``，找不到记外部地址；回来的 ``sourceUrl`` 都是这个地址。它不进
        ``request``、不发上游。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_image(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return await envelope(job)

    @router.get("", response_model=GenerationsPageOut)
    async def list_generations(
        principal: Annotated[Principal, require_permission("generation:read")],
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        conversation_id: Annotated[uuid.UUID | None, Query(alias="conversationId")] = None,
        task_id: Annotated[uuid.UUID | None, Query(alias="taskId")] = None,
        shot_index: Annotated[
            int | None,
            Query(alias="shotIndex", ge=1, description="只列这个镜头组编号的视频记录"),
        ] = None,
        kind: GenerationKind | None = None,
        operation: GenerationOperation | None = None,
        root_job_id: Annotated[
            uuid.UUID | None,
            Query(alias="rootJobId", description="只列以这条出片为原作的记录（整条编辑链）"),
        ] = None,
        source_job_id: Annotated[
            uuid.UUID | None,
            Query(alias="sourceJobId", description="只列直接基于这一条的记录"),
        ] = None,
        metadata: Annotated[
            str | None,
            Query(description="JSON 对象；只列 metadata 包含这些键值的记录，服务端不解释其中的键"),
        ] = None,
        before: uuid.UUID | None = None,
    ) -> GenerationsPageOut:
        """给了 ``conversationId`` / ``taskId`` / ``shotIndex`` / ``rootJobId`` / ``sourceJobId`` 就
        只列那段对话、那张需求单下、那个镜号、以那条为原作或直接来源的记录；``kind`` /
        ``operation`` 按种类与操作筛。按对话列时含这段对话经分叉继承的记录（调用方读得到这段
        对话才算），其余可见性口径不变。

        ``metadata`` 在查询串里是一段 JSON 对象，按包含匹配筛（分镜页拿它按镜头组与帧查图片）。

        按属主列会看到上传记录，按对话列图片会看到切图记录；只要调模型的，按 ``operation=generate`` 筛。
        素材片的字幕记录是种类 ``subtitle``、来源是那条素材片，按 ``kind=subtitle`` 与 ``sourceJobId`` 找。
        一段对话的背景音乐按 ``kind=audio`` 与 ``conversationId`` 找，生成的与确认时挂到这段对话的上传
        都在里面；没挂对话的上传按属主列。
        """

        jobs = await service.list_recent(
            principal,
            limit=limit,
            conversation_id=conversation_id,
            kind=kind,
            operation=operation,
            metadata=_metadata_filter(metadata),
            task_id=task_id,
            shot_index=shot_index,
            root_job_id=root_job_id,
            source_job_id=source_job_id,
            before=before,
        )
        addresses = await service.source_addresses(jobs)
        return GenerationsPageOut(
            items=[generation_out(job, source_address=addresses.get(job.id)) for job in jobs]
        )

    # 带固定路径段的都要声明在 /{job_id} 之前，否则被路径参数吞掉。
    @router.get("/video-models", response_model=VideoModelsOut)
    async def list_video_models(
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> VideoModelsOut:
        """返回允许的视频模型与默认模型；clipModels 另外声明片段图生、编辑的支持和时长范围。"""

        return service.video_models()

    @router.get("/image-models", response_model=ImageModelsOut)
    async def list_image_models(
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> ImageModelsOut:
        """列出接入了哪几家图片模型与各家支持的档位；受理层照同一份声明校验。"""

        default, models = service.image_models()
        return ImageModelsOut(
            default=default,
            items=[
                ImageModelOut(
                    model=name,
                    label=spec.label,
                    aspect_ratios=spec.aspect_ratios,
                    resolutions=spec.resolutions,
                    channels=spec.channels,
                )
                for name, spec in models
            ],
        )

    @router.get("/video/{task_id}", response_model=VideoTaskOut)
    async def get_video_task(
        task_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> VideoTaskOut:
        """视频任务快照，照上游任务查询的形状。只认调上游的视频记录（出片与编辑段），可见性与
        ``GET /generations/{id}`` 相同。"""

        return video_task_out(await service.get_video(principal, task_id))

    @router.get("/{job_id}/enhancements", response_model=VideoEnhancementsOut)
    async def list_video_enhancements(
        job_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> VideoEnhancementsOut:
        """一条视频能做的高清版各档（比它清晰的，按运行配置的先后）与各档最近的一条超分记录（谁提的
        都算，``mine`` 标它是不是读的人的），以及下载高清版时要记下载事件的素材片。

        来源不按属主取，id 不存在 404。来源不是素材片或导出完成的成片时两项都空；高清版没开通时
        ``tiers`` 为空。
        """

        found = await service.enhancements(job_id)
        jobs = [tier.job for tier in found.tiers if tier.job is not None]
        addresses = await service.source_addresses(jobs)
        return VideoEnhancementsOut(
            downloaded_job_ids=list(found.downloaded_job_ids),
            tiers=[
                VideoEnhanceTierOut(
                    resolution=tier.resolution,
                    job=None
                    if tier.job is None
                    else generation_out(tier.job, source_address=addresses.get(tier.job.id)),
                    mine=tier.job is not None and tier.job.owner_user_id == principal.user_id,
                )
                for tier in found.tiers
            ],
        )

    @router.get("/{job_id}", response_model=GenerationEnvelope)
    async def get_generation(
        job_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> GenerationEnvelope:
        """一条可见的生成记录。上传记录的 id 就是确认上传时的 ``uploadId``。"""

        return await envelope(await service.get(principal, job_id))

    return router


_METADATA_FILTER = TypeAdapter(Metadata)


def _metadata_filter(raw: str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise ValidationFailed(f"metadata 不是合法 JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValidationFailed("metadata 必须是 JSON 对象")
    try:
        return _METADATA_FILTER.validate_python(parsed)
    except ValidationError as exc:
        raise ValidationFailed(validation_error_detail(exc.errors())) from exc


__all__ = ["create_generations_router"]
