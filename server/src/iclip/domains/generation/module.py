from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import httpx
import procrastinate

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.gpt_image import GPT_IMAGE_2_5
from iclip.domains.generation.image_upstream import (
    GatewayImageModel,
    GatewayImageProvider,
    GatewayImageSettings,
)
from iclip.domains.generation.models import STATUS_SUBMITTING, GenerationJob
from iclip.domains.generation.music import MUSIC_MODEL, QwenMusicProvider
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.ports import BrandTemplates, ConversationLineage
from iclip.domains.generation.processing import FfmpegComposeProvider, ReportStage
from iclip.domains.generation.provider import GenerationProvider, ImageModelSpec
from iclip.domains.generation.queue import (
    GenerationQueue,
    GenerationQueueSettings,
    ProviderLane,
)
from iclip.domains.generation.qwen import QwenEndpoint
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import ClipStage
from iclip.domains.generation.seedream import SEEDREAM_V5_PRO
from iclip.domains.generation.service import (
    ClearCompletion,
    GenerationService,
    ProviderTarget,
)
from iclip.domains.generation.subtitles import SUBTITLE_MODEL, QwenSubtitleProvider
from iclip.domains.generation.video import HttpVideoProvider, VideoProviderSettings
from iclip.domains.identity.public import ActAs
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.fonts import ProbeFont
from iclip.platform.media.probe import (
    VideoProfile,
    probe_remote_duration_ms,
    probe_remote_video,
)
from iclip.platform.object_store.store import PublicObjectStore


@dataclass(frozen=True, slots=True)
class ImageModelConfig:
    name: str
    api_base: str
    concurrency: int
    text_to_image_task: str | None = None
    image_edit_task: str | None = None


@dataclass(frozen=True, slots=True)
class QwenServiceConfig:
    endpoint: QwenEndpoint
    concurrency: int


@dataclass(frozen=True)
class GenerationModule:
    routers: tuple[Any, ...]
    service: GenerationService
    queue: GenerationQueue
    image_models: frozenset[str]


def build_generation_module(
    repo: GenerationRepository,
    *,
    act_as: ActAs,
    clear_completion: ClearCompletion,
    lineage: ConversationLineage,
    brand_templates: BrandTemplates,
    probe_font: ProbeFont,
    video: VideoProviderSettings,
    video_default_model: str,
    video_allowed_models: tuple[str, ...],
    image_models: Sequence[ImageModelConfig],
    image_default_model: str,
    image_env: str,
    image_text_to_image_task: str,
    image_edit_task: str,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector,
    media_codec: MediaCodec,
    fetch_url: Callable[[str], str],
    queue_settings: GenerationQueueSettings | None = None,
    subtitles: QwenServiceConfig | None = None,
    music: QwenServiceConfig | None = None,
    video_transport: httpx.AsyncBaseTransport | None = None,
    image_transport: httpx.AsyncBaseTransport | None = None,
    subtitle_transport: httpx.AsyncBaseTransport | None = None,
    music_transport: httpx.AsyncBaseTransport | None = None,
) -> GenerationModule:
    if not image_models:
        raise RuntimeError("媒体生成开着却一家图片模型都没声明")
    declared = [model.name for model in image_models]
    if image_default_model not in declared:
        raise RuntimeError(
            f"默认图片模型 {image_default_model} 不在声明的那几家里（{'、'.join(declared)}）"
        )
    settings = queue_settings or GenerationQueueSettings()
    report_stage = _clip_stage_reporter(repo)
    video_provider = HttpVideoProvider(video, transport=video_transport)
    compose_provider = FfmpegComposeProvider(
        object_store=object_store, report_stage=report_stage, codec=media_codec, fetch_url=fetch_url
    )

    image_providers = [
        _image_provider(
            model,
            env=image_env,
            text_to_image_task=image_text_to_image_task,
            image_edit_task=image_edit_task,
            object_store=object_store,
            transport=image_transport,
        )
        for model in image_models
    ]
    subtitle_lanes: tuple[ProviderLane, ...] = ()
    subtitle_target: ProviderTarget | None = None
    if subtitles is not None:
        subtitle_provider = QwenSubtitleProvider(
            subtitles.endpoint, fetch_url=fetch_url, transport=subtitle_transport
        )
        subtitle_lanes = (ProviderLane(subtitle_provider, subtitles.concurrency),)
        subtitle_target = ProviderTarget(provider=subtitle_provider.name, model=SUBTITLE_MODEL)
    music_lanes: tuple[ProviderLane, ...] = ()
    music_target: ProviderTarget | None = None
    if music is not None:
        music_provider = QwenMusicProvider(
            music.endpoint, object_store=object_store, transport=music_transport
        )
        music_lanes = (ProviderLane(music_provider, music.concurrency),)
        music_target = ProviderTarget(provider=music_provider.name, model=MUSIC_MODEL)

    async def transcribe_completed(job: GenerationJob) -> None:
        await service.transcribe_completed(job)

    queue = GenerationQueue(
        repo,
        lanes=(
            ProviderLane(video_provider, settings.video_submit_concurrency),
            ProviderLane(compose_provider, settings.compose_concurrency),
            *(
                ProviderLane(provider, model.concurrency)
                for provider, model in zip(image_providers, image_models, strict=True)
            ),
            *subtitle_lanes,
            *music_lanes,
        ),
        connector=queue_connector,
        settings=queue_settings,
        on_completed=transcribe_completed if subtitle_target is not None else None,
    )
    service = GenerationService(
        repo,
        queue,
        video_provider_name=video_provider.name,
        compose_provider_name=compose_provider.name,
        video_default_model=video_default_model,
        video_allowed_models=video_allowed_models,
        image_models={name: IMAGE_MODEL_SPECS[name] for name in declared},
        image_default_model=image_default_model,
        clear_completion=clear_completion,
        lineage=lineage,
        media_probe=_FetchingProbe(fetch_url),
        brand_templates=brand_templates,
        probe_font=probe_font,
        subtitles=subtitle_target,
        music=music_target,
    )
    return GenerationModule(
        routers=(create_generations_router(service, act_as=act_as),),
        service=service,
        queue=queue,
        image_models=frozenset(declared),
    )


_IMAGE_MODELS: Final[Mapping[str, GatewayImageModel]] = {
    model.name: model for model in (NANO_BANANA_PRO, SEEDREAM_V5_PRO, GPT_IMAGE_2_5)
}

IMAGE_MODEL_SPECS: Final[Mapping[str, ImageModelSpec]] = {
    name: model.spec for name, model in _IMAGE_MODELS.items()
}


@dataclass(frozen=True, slots=True)
class _FetchingProbe:
    fetch_url: Callable[[str], str]

    async def duration_ms(self, url: str) -> int:
        return await probe_remote_duration_ms(self.fetch_url(url))

    async def video_profile(self, url: str) -> VideoProfile:
        return await probe_remote_video(self.fetch_url(url))


def _clip_stage_reporter(repo: GenerationRepository) -> ReportStage:
    async def report(job_id: uuid.UUID, stage: ClipStage) -> bool:
        updated = await repo.record_progress(
            job_id, provider_status=stage, only_if_status=STATUS_SUBMITTING
        )
        return updated is not None

    return report


def _image_provider(
    config: ImageModelConfig,
    *,
    env: str,
    text_to_image_task: str,
    image_edit_task: str,
    object_store: PublicObjectStore,
    transport: httpx.AsyncBaseTransport | None,
) -> GenerationProvider:
    model = _IMAGE_MODELS.get(config.name)
    if model is None:
        raise RuntimeError(
            f"没有 {config.name} 这家图片模型的适配器（现有：{'、'.join(_IMAGE_MODELS)}）"
        )
    return GatewayImageProvider(
        model,
        GatewayImageSettings(
            api_base=config.api_base,
            env=env,
            text_to_image_task=config.text_to_image_task or text_to_image_task,
            image_edit_task=config.image_edit_task or image_edit_task,
        ),
        object_store=object_store,
        transport=transport,
    )


__all__ = [
    "IMAGE_MODEL_SPECS",
    "GenerationModule",
    "ImageModelConfig",
    "QwenServiceConfig",
    "build_generation_module",
]
