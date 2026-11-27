from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import TypeAdapter, ValidationError

from iclip.common.errors import ValidationFailed, validation_error_detail
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import (
    DubbingIn,
    GenerationEnvelope,
    GenerationKind,
    GenerationOperation,
    GenerationsPageOut,
    ImageGenerationIn,
    ImageModelOut,
    ImageModelsOut,
    Metadata,
    MusicIn,
    SpeechIn,
    SubtitleIn,
    VideoComposeIn,
    VideoDraftCompletionIn,
    VideoEditIn,
    VideoEnhanceIn,
    VideoEnhancementsOut,
    VideoEnhanceTierOut,
    VideoGenerationIn,
    VideoModelsOut,
    VideoSubmitOut,
    VideoTaskOut,
    VideoTransitionIn,
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
        API key 调用方必填、照收；浏览器会话可省略，填登录用户名。``reference_ids`` 可选，是这次
        用到的参考资产，有一条不在资料库或已移除就 422；原样记进请求，不发上游。

        传入 ``provider_options.draft: true`` 即生成样片并原样转发上游；完成后可通过
        ``POST /generations/video-draft-completions`` 转为 1080p。
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
        """为素材片上的区间生成替换片段。mode 为 image 时图生，为 edit 时编辑；模型与两种模式的
        时长能力由 video-models 声明。图生必须引用图片并用 seconds 指定整秒时长；编辑不收
        seconds，区间长度（终点超出基底时算到基底结尾）要满足模型的编辑时长限制。不合格 422、不入队。

        编辑模式由服务端在交上游之前从基底精确切出所选区间作参考视频：片段长期保存，地址受理时
        就记进 request.reference_video_urls；切段期间 clipStage 依次报 fetching / processing /
        uploading。取不到基底记 MEDIA_SOURCE_UNREACHABLE、切段失败记 MEDIA_PROCESS_FAILED、
        存不进桶记 OUTPUT_STORE_FAILED，都不重试，此时不会交给上游。

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

    @router.post("/video-transitions", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_transition(
        body: VideoTransitionIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """生成一段把两条素材片顺滑接起来的衔接段。A 保留到 left_end_ms，B 从 right_start_ms
        开始保留，衔接段放在两者之间；拿到它之后用 video-composites 以 A 为基底、按
        [A 的 0 到 left_end_ms、衔接段、B 的 right_start_ms 到结尾] 拼成一条。

        mode 为 first_last_frame 时，服务端抽出 A 在 left_end_ms 之前的最后一帧作首帧、B 保留部分
        的第一帧（不早于 right_start_ms 的第一帧）作尾帧图生过渡（时间点越过结尾取最后一帧），seconds 必填、须在模型
        图生时长之内；为 video_edit 时，服务端把 A 的 [left_end_ms, A 结尾) 与 B 的
        [0, right_start_ms) 按 A 的画幅帧率拼成参考视频，按模型的视频编辑模式重做接缝，不收
        seconds，两段合计时长须在模型编辑时长之内。帧和参考片段都长期保存，地址受理时就记进
        request.reference_image_urls / request.reference_video_urls；准备期间 clipStage 依次报
        fetching / processing / uploading，取不到素材片记 MEDIA_SOURCE_UNREACHABLE、加工失败记
        MEDIA_PROCESS_FAILED、存不进桶记 OUTPUT_STORE_FAILED，都不重试，此时不会交给上游。

        A、B 须为本对话自己的或继承来的两条不同的已完成素材片，left_end_ms / right_start_ms 不超出
        各自时长（容差 50 毫秒）。resolution / aspect_ratio / generate_audio 传了就原样转给上游，
        resolution 不传时沿用 A 原片最初出片的设置。记录为 video / generate，来源与原作、镜号随 A，
        没有替换区间；衔接方式与两个接点记在 request 里，不发上游。不合格 422、不入队。
        user_name 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_transition(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return await envelope(job)

    @router.post("/video-composites", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_composite(
        body: VideoComposeIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """按片段列表拼成一条新素材片，来源记基底，原作与镜号随基底。不经外部服务。

        ``baseJobId`` 必须是这段对话自己的或继承来的一条已完成素材片，产物的宽高与帧率以它为准
        （基底不必出现在片段里）；有一段带音轨就出音轨。``segments`` 每段的 ``sourceJobId`` 是
        这段对话（含继承）里任一条已完成素材片或已完成编辑段，``start`` / ``end`` 是那条记录自己
        的媒体时间（秒），``end`` 省略即取到结尾。服务端把出处换成地址，记进
        ``request.segments``。``userName`` 的规则同出片。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_video_compose(
            principal, body.model_copy(update={"user_name": user_name})
        )
        return await envelope(job)

    @router.post("/video-draft-completions", response_model=GenerationEnvelope, status_code=202)
    async def submit_video_draft_completion(
        body: VideoDraftCompletionIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """将已完成的样片（携带 ``provider_options.draft: true`` 的出片）转为 1080p，创建一条新的普通出片
        （``kind: video``、``operation: generate``，不记录来源与原作）。镜号、需求单与 ``metadata`` 沿用样片，
        归属对话取 ``conversationId``；请求快照将样片请求的 ``resolution`` 改为 ``"1080p"``、移除
        ``provider_options``，并在 ``draft_job_id`` 中记录样片 ID。

        ``draftJobId`` 须为本对话自有或继承的已完成且具备上游任务号的样片，否则返回 422；未开通样片功能返回 422。
        同一样片在同一对话下已有未失败转出记录时幂等返回该记录，不新建任务。``userName`` 仅用于 ``users:act_as``
        切换数据归属；发给上游的 ``user_name`` 固定沿用样片记录中的取值（上游要求转 1080p 与样片一致）。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_draft_completion(principal, body)
        return await envelope(job)

    @router.post("/subtitles", response_model=GenerationEnvelope, status_code=202)
    async def submit_subtitle(
        body: SubtitleIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """按需识别一条素材片的口播，另起一条字幕记录（种类 ``subtitle``）；素材片完成时不会识别，
        只有调这个接口才识别。结果在记录的 ``sentences`` 里。

        ``sourceJobId`` 要是这段对话（``conversationId``）自己的或继承来的一条视频，读不到 404；读得到
        却不是素材片（已完成的出片或合成）422。字幕识别没开通 422。新记录的对话、需求单与 ``metadata``
        取请求；``userName`` 的规则同出片，只用来替人办事，不进 ``request``。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_subtitle(principal, body)
        return await envelope(job)

    @router.post("/dubbings", response_model=GenerationEnvelope, status_code=202)
    async def submit_dubbing(
        body: DubbingIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """给一条素材片配音，另起一条配音记录（种类 ``dubbing``）。

        用参考音频的声音把 ``lines`` 每句的字合成出来（给了 ``locale`` 时用这种语言念，不给时不声明
        语言，final-cut 的原文就是这样），放在这句的开始，能占到下一句开始（最后一句
        到视频结尾），写了 ``slotEndMs`` 的不超过它；合成出来更长时先加速，最多 1.25 倍，还放不下
        就截掉尾巴并淡出；没占到的地方是静音。拼成一条和
        素材片等长的音轨，地址在 ``outputUrl``，每句的倍数和是否截掉在 ``dubbedLines``。参考音频是
        ``original`` 时从原声里截被说话时段（``spans``，不写时是 ``lines``）覆盖得最多的一段（不超过
        10 秒），覆盖不到 3 秒记录失败，``spans`` 的规则同 ``lines``，超出素材片的时长 422；是 ``reference_audio`` 时取参考音频库里那条音色（要没移除、是音色，否则 422），是
        ``upload`` 时取调用者本人那条音频上传（否则 422），都取前 10 秒。记录的 ``request.reference``
        里记着用到的地址，音色另记 ``referenceId`` 与台词，上传另记 ``uploadId``。

        ``sourceJobId`` 的规则同字幕识别：读不到 404，不是素材片 422。``lines`` 不合规、超出上限或
        超出素材片的时长 422。配音没开通 422。``userName`` 的规则同出片，只用来替人办事，不进
        ``request``。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_dubbing(principal, body)
        return await envelope(job)

    @router.post("/speeches", response_model=GenerationEnvelope, status_code=202)
    async def submit_speech(
        body: SpeechIn,
        principal: Annotated[Principal, require_permission("generation:submit")],
    ) -> GenerationEnvelope:
        """按文字合成一段语音（final-cut 的旁白配音），另起一条记录（种类 ``speech``）。

        用参考音频库里那条音色（要没移除、是音色，否则 422；取前 10 秒）的声音把 ``text`` 念出来，给了
        ``locale`` 时写明用这种语言念，不给时不写。给了 ``maxDurationMs`` 时念出来更长就先加速，最多
        1.25 倍，还放不下就截到这个长度并淡出；不补静音，念多长（加速后）就多长。产物是一段 m4a
        （``outputUrl``，时长在 ``durationMs``），加速了多少、截没截在 ``dubbedLines`` 唯一的一项里。
        ``text`` 的字数上限同配音每句；给了 ``conversationId`` 却读不到这段对话 404；配音没开通 422。
        ``userName`` 的规则同出片，只用来替人办事，不进 ``request``。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        job = await service.submit_speech(principal, body)
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

        帧图编辑带 ``sourceUrl``（底图地址）：在本对话及它继承的生成图片里找，找到记
        ``sourceJobId``，找不到（上传的图、外链）记这个地址；回来的 ``sourceUrl`` 都是这个地址。它不进
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

        生成记录只记生成，对话的上传在 ``GET /conversations/{id}/uploads`` 里列。按对话列图片会看到
        切图记录；只要调模型的，按 ``operation=generate`` 筛。参考视频的试生成是 ``operation=trial``，
        按 ``generate`` 筛时不在里面。素材片的字幕记录是种类 ``subtitle``、
        来源是那条素材片，按 ``kind=subtitle`` 与 ``sourceJobId`` 找。一段对话生成的背景音乐按
        ``kind=audio`` 与 ``conversationId`` 找。
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

    @router.get("/video-models", response_model=VideoModelsOut)
    async def list_video_models(
        principal: Annotated[Principal, require_permission("generation:read")],
    ) -> VideoModelsOut:
        """返回允许的视频模型与默认模型；``clipModels`` 声明片段图生与编辑能力及时长范围；
        ``draftModels`` 列出支持样片的模型（未开通样片功能时为空）。"""

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
        都算，``mine`` 标它是不是读的人的）。

        来源不按属主取，id 不存在 404。来源不是素材片或导出完成的成片、高清版没开通时 ``tiers`` 为空。
        """

        found = await service.enhancements(job_id)
        jobs = [tier.job for tier in found.tiers if tier.job is not None]
        addresses = await service.source_addresses(jobs)
        return VideoEnhancementsOut(
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
        """一条可见的生成记录。"""

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
