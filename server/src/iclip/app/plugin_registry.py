"""插件登记表：插件名到绑好服务的插件类。

插件类只在 ``build_plugin_registry`` 一处列出；组合根启动时把连接池与领域服务等运行对象 ``bind`` 进类，
登记表的值既是交给 pydantic-ai ``custom_capability_types`` 的类，也带着配置页与工具卡用的界面元数据。
agent 配置只按插件名引用。"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import httpx
from pydantic import ValidationError

from iclip.app.film_images import FilmImagesAdapter
from iclip.app.reference_breakdown import ReferenceBreakdownsAdapter
from iclip.common.errors import ValidationFailed
from iclip.config import ResolvedIclipStudio, ResolvedShotVideo, ResolvedVideo
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService, SettledRecords
from iclip.domains.identity.public import Principal
from iclip.domains.references.service import ReferenceService
from iclip.harness.agents import delegate_display_table
from iclip.harness.media import image_info_url
from iclip.harness.skills import skill_display_table
from iclip.platform.file_store.store import FileSpace, FileStore
from iclip.platform.http import validation_error_detail
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.media.codec import MediaCodec
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicBucket
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.plugins.base import CapPlugin
from iclip.plugins.iclip_studio.capability import IclipStudio
from iclip.plugins.shot_video.capability import GenerationPolicy, ShotVideo
from iclip.plugins.shot_video.ports import (
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    ObjectWriteFailed,
)
from iclip.plugins.video.capability import Video
from iclip.plugins.video_breakdown.capability import VideoBreakdownPlugin
from iclip.plugins.video_shots.capability import VideoShots
from iclip.plugins.video_understanding import ArkVideoUnderstanding
from iclip.plugins.workspace.capability import Workspace
from iclip.plugins.workspace.ports import ImageInfo, MediaProbeFailed
from iclip.plugins.workspace.scope import workspace_namespace

PluginRegistry = Mapping[str, type[CapPlugin[Any]]]
"""插件名对应绑好服务的插件类；装配时整张表交给 ``Agent.from_spec``，由它按 spec 各造一份实例。"""


class GenerationsAdapter:
    """将能力请求转换为生成域的统一请求模型，并将任务记录收窄为能力协议字段；切出来的格子交给
    生成域记成切图记录。"""

    def __init__(self, service: GenerationService, records: SettledRecords) -> None:
        self._service = service
        self._records = records

    async def submit(self, principal: Principal, request: ImageRequest) -> ImageJob:
        try:
            # 模型输入为自由字符串，由生成域请求模型统一校验枚举。
            payload = ImageGenerationIn.model_validate(
                {
                    "prompt": request.prompt,
                    "user_name": request.user_name,
                    "model": request.model,
                    "channel": request.channel,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                    "reference_image_urls": list(request.reference_image_urls),
                    "conversation_id": request.conversation_id,
                }
            )
            return _job_view(await self._service.submit_image(principal, payload))
        except ValidationError as exc:
            raise InvalidImageRequest(validation_error_detail(exc.errors())) from exc
        except ValidationFailed as exc:
            # 受理层按所选模型的能力拒绝，收成能力协议错误，工具才能让模型改参数。
            raise InvalidImageRequest(str(exc)) from exc

    async def get(self, principal: Principal, job_id: uuid.UUID) -> ImageJob:
        return _job_view(await self._service.get(principal, job_id))

    async def record_cuts(
        self, principal: Principal, grid_job_id: uuid.UUID, urls: Sequence[str]
    ) -> None:
        await self._records.record_cuts(principal, grid_job_id, urls)


_IMAGE_MEDIA_TYPES: Mapping[str, str] = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
}


class OssMediaProbe:
    """通过 OSS image/info 查询尺寸、大小与格式，无需下载像素。

    查询地址由 ``harness.media`` 构造，先经 ``fetch_url`` 换算（本桶对象走内网）再挂参数；对外
    错误使用固定文案，避免回显带参数的地址。"""

    def __init__(self, client: httpx.AsyncClient, *, fetch_url: Callable[[str], str]) -> None:
        self._client = client
        self._fetch_url = fetch_url

    async def image_info(self, url: str) -> ImageInfo:
        try:
            info_url = image_info_url(self._fetch_url(url))
        except ValueError as exc:
            raise MediaProbeFailed("不是能挂 OSS 处理参数的地址") from exc
        try:
            response = await self._client.get(info_url)
        except httpx.HTTPError as exc:
            raise MediaProbeFailed("地址访问不到") from exc
        if response.status_code >= 400:
            raise MediaProbeFailed(f"对方返回 {response.status_code}")
        try:
            info = response.json()
            image_format = str(info["Format"]["value"]).lower()
            return ImageInfo(
                media_type=_IMAGE_MEDIA_TYPES.get(image_format, f"image/{image_format}"),
                size_bytes=int(info["FileSize"]["value"]),
                width=int(info["ImageWidth"]["value"]),
                height=int(info["ImageHeight"]["value"]),
            )
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            raise MediaProbeFailed("对方给的不是图片信息") from exc


class ObjectWriterAdapter:
    """将对象存储异常转换为能力协议错误，使工具可报告失败而非终止整个运行。"""

    def __init__(self, store: PublicBucket) -> None:
        self._store = store

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        try:
            return await self._store.put_public_object(
                object_key=object_key, content=content, content_type=content_type
            )
        except ObjectStoreUnavailable as exc:
            raise ObjectWriteFailed(str(exc)) from exc

    def public_url(self, object_key: str) -> str:
        return self._store.public_url(object_key)


def _job_view(job: GenerationJob) -> ImageJob:
    """生成任务到能力结果的投影，渠道取实际请求快照。"""

    request = job.request
    if not isinstance(request, ImageGenerationIn):
        # 出图适配器只提交图片请求；拿回视频请求说明装配串了，不替它编一个渠道。
        raise TypeError(f"图像任务 {job.id} 的请求是 {job.kind}")
    if request.channel is None:
        # 出图钉死的那家有渠道轴（装配期校验过），为空同样说明装配串了。
        raise TypeError(f"图像任务 {job.id} 没有渠道")
    return ImageJob(
        job_id=job.id,
        status=job.status,
        channel=request.channel,
        output_url=job.output.url,
        error_code=job.error_code,
        error_message=job.error_message,
    )


def build_plugin_registry(
    *,
    workspace_store: FileStore,
    material_ledger: MaterialLedger,
    http_client: httpx.AsyncClient,
    fetch_url: Callable[[str], str],
    generation_service: GenerationService | None = None,
    settled_records: SettledRecords | None = None,
    object_store: PublicBucket | None = None,
    video: ResolvedVideo | None = None,
    shot_video: ResolvedShotVideo | None = None,
    iclip_studio: ResolvedIclipStudio | None = None,
    reference_service: ReferenceService | None = None,
    image_models: frozenset[str] = frozenset(),
    media_codec: MediaCodec | None = None,
) -> PluginRegistry:
    """按组合根递进来的运行值把插件类绑好服务登记进来，没给的不登记。

    ``fetch_url`` 是本服务下载本桶对象前的地址换算，交给查图片信息与取帧、出图的下载。
    ``shot_video`` 由组合根按 ``ResolvedSettings.shot_tools_enabled`` 决定是否传入；传了却缺
    媒体生成、切图记录、对象存储或取帧用的编解码（``media_codec``）是装配错误，直接报。
    ``iclip_studio`` 是拆解的配置段，传了就登记 ``video_breakdown``；传了却缺参考视频服务（拆解
    配好的那个）同样直接报。
    """

    # 文件生产与读取共用 FileSpace，避免命名空间不一致。
    space = FileSpace(store=workspace_store, namespace=workspace_namespace)
    plugins: list[type[CapPlugin[Any]]] = [
        Workspace.bind(
            space=space,
            probe=OssMediaProbe(http_client, fetch_url=fetch_url),
            ledger=material_ledger,
        ),
        IclipStudio.bind(
            space=space,
            ledger=material_ledger,
            images=(
                FilmImagesAdapter(generation_service) if generation_service is not None else None
            ),
        ),
        VideoShots.bind(space=space, ledger=material_ledger),
    ]
    if video is not None:
        plugins.append(
            Video.bind(
                space=space,
                ledger=material_ledger,
                understanding=ArkVideoUnderstanding(
                    http_client,
                    url=video.understanding_url,
                    api_key=video.understanding_api_key,
                    model=video.understanding_model,
                    thinking=video.understanding_thinking,
                    fps=video.understanding_fps,
                ),
            )
        )
    if iclip_studio is not None:
        if reference_service is None:
            raise RuntimeError(
                "装配 video_breakdown 要有参考视频服务：对话里拆的视频与资料库共用一份拆解；"
                "组合根应在配了 iclip_studio 时传入"
            )
        plugins.append(
            VideoBreakdownPlugin.bind(
                space=space, breakdowns=ReferenceBreakdownsAdapter(reference_service)
            )
        )
    if shot_video is not None:
        if (
            generation_service is None
            or settled_records is None
            or object_store is None
            or media_codec is None
        ):
            raise RuntimeError(
                "装配 shot_video 要有媒体生成服务、切图记录、对象存储与编解码；"
                "组合根应按 shot_tools_enabled 决定是否传入"
            )
        plugins.append(
            ShotVideo.bind(
                space=space,
                ledger=material_ledger,
                generations=GenerationsAdapter(generation_service, settled_records),
                objects=ObjectWriterAdapter(object_store),
                paths=MEDIA_PATHS,
                client=http_client,
                fetch_url=fetch_url,
                image_models=image_models,
                policy=GenerationPolicy(
                    poll_interval_seconds=shot_video.poll_interval_seconds,
                    dev_attempts=shot_video.dev_attempts,
                    pro_attempts=shot_video.pro_attempts,
                    backoff_seconds=shot_video.backoff_seconds,
                    backoff_factor=shot_video.backoff_factor,
                    total_timeout_seconds=shot_video.job_timeout_seconds,
                ),
                codec=media_codec,
            )
        )
    return {plugin.get_serialization_name(): plugin for plugin in plugins}


def build_display_registry(registry: PluginRegistry) -> ToolDisplayRegistry:
    """合并插件、技能与委派工具的显示表，重复工具名在装配期报错。实时与历史共用结果实例。"""

    return ToolDisplayRegistry.merged(
        *(plugin.display_table() for plugin in registry.values()),
        skill_display_table(),
        delegate_display_table(),
    )


__all__ = [
    "GenerationsAdapter",
    "ObjectWriterAdapter",
    "OssMediaProbe",
    "PluginRegistry",
    "build_display_registry",
    "build_plugin_registry",
]
