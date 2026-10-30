"""取帧与出图插件的内存替身（生成、对象存储、切图记录和视频解析），以及用后端真实媒体适配器装配
插件的入口。"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import get_args

import httpx
from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import MaterialLedger
from iclip_video.shot_video.capability import GenerationPolicy, ShotVideo
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.shot_video.ports import (
    ImageChannel,
    ImageGenerations,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
)

from iclip.app.shot_media import FrameBoardsAdapter, GridCutsAdapter
from iclip.domains.generation.schemas import IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS
from iclip.platform.media.codec import MediaCodec
from iclip.platform.object_store.layout import MEDIA_PATHS

_ASPECT_RATIOS: frozenset[str] = frozenset(get_args(IMAGE_ASPECT_RATIOS))
_RESOLUTIONS: frozenset[str] = frozenset(get_args(IMAGE_RESOLUTIONS))


@dataclass(frozen=True, slots=True)
class Outcome:
    """预设的生成结果。"""

    status: str = "completed"
    output_url: str | None = "https://cdn.test/out.png"
    error_code: str | None = None
    error_message: str | None = None


@dataclass
class FakeGenerations:
    """按预设顺序返回结果，耗尽后重复最后一条。

    submit 始终返回 pending，get 才返回结果，以覆盖工具的轮询逻辑。
    """

    outcomes: list[Outcome] = field(default_factory=lambda: [Outcome()])
    submitted: list[ImageRequest] = field(default_factory=list[ImageRequest])
    job_ids: list[uuid.UUID] = field(default_factory=list[uuid.UUID])
    polls: int = 0
    jobs: dict[uuid.UUID, tuple[ImageChannel, Outcome]] = field(
        default_factory=dict[uuid.UUID, tuple[ImageChannel, Outcome]]
    )

    async def submit(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob:
        _ = user_id
        if request.aspect_ratio not in _ASPECT_RATIOS:
            raise InvalidImageRequest(f"aspect_ratio: 不是可选的画幅 {request.aspect_ratio!r}")
        if request.resolution not in _RESOLUTIONS:
            raise InvalidImageRequest(f"resolution: 不是可选的档位 {request.resolution!r}")
        index = len(self.submitted)
        self.submitted.append(request)
        outcome = self.outcomes[min(index, len(self.outcomes) - 1)]
        job_id = uuid.uuid4()
        self.job_ids.append(job_id)
        self.jobs[job_id] = (request.channel, outcome)
        return ImageJob(job_id=job_id, status="pending", channel=request.channel)

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob:
        _ = user_id
        self.polls += 1
        channel, outcome = self.jobs[job_id]
        return ImageJob(
            job_id=job_id,
            status=outcome.status,  # type: ignore[arg-type]
            channel=channel,
            output_url=outcome.output_url if outcome.status == "completed" else None,
            error_code=outcome.error_code,
            error_message=outcome.error_message,
        )

    def channels(self) -> list[str]:
        return [request.channel for request in self.submitted]


@dataclass
class FakeCutRecords:
    """记下每次记的切图：(宫格任务号, 各格地址)；设了 ``error`` 就抛它，模拟落库失败。"""

    cuts: list[tuple[uuid.UUID, tuple[str, ...]]] = field(
        default_factory=list[tuple[uuid.UUID, tuple[str, ...]]]
    )
    error: Exception | None = None

    async def record_cuts(
        self, user_id: uuid.UUID, grid_job_id: uuid.UUID, urls: Sequence[str]
    ) -> None:
        _ = user_id
        if self.error is not None:
            raise self.error
        self.cuts.append((grid_job_id, tuple(urls)))


@dataclass
class FakeObjects:
    """记录对象 key 并返回固定格式的 URL；设置 error 后写入抛出该异常。"""

    written: dict[str, bytes] = field(default_factory=dict[str, bytes])
    error: Exception | None = None

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        _ = content_type
        if self.error is not None:
            raise self.error
        self.written[object_key] = content
        return self.public_url(object_key)

    def public_url(self, object_key: str) -> str:
        return f"https://cdn.test/{object_key}"


@dataclass
class FakeUnderstanding:
    """返回预设文档或抛出预设异常。"""

    document: str = "## 4、逐镜拉片表\n**[00:00.000-00:03.800]** 中景……"
    error: Exception | None = None
    calls: list[str] = field(default_factory=list[str])

    async def parse(self, video_url: str) -> str:
        self.calls.append(video_url)
        if self.error is not None:
            raise self.error
        return self.document


def mount_shot_video(
    *,
    space: FileSpace,
    ledger: MaterialLedger,
    generations: ImageGenerations,
    objects: FakeObjects,
    records: FakeCutRecords,
    client: httpx.AsyncClient,
    fetch_url: Callable[[str], str],
    policy: GenerationPolicy,
    codec: MediaCodec,
) -> ShotVideo[object]:
    """经 ``ShotVideo.bind`` 接上后端真实的取帧拼板与切格适配器、再 ``from_spec`` 造一份 capability，
    和组合根挂给 agent 的同一条路；生成、对象存储与切图记录用替身。"""

    return ShotVideo.bind(
        space=space,
        ledger=ledger,
        generations=generations,
        boards=FrameBoardsAdapter(client, fetch_url=fetch_url, objects=objects, codec=codec),
        cuts=GridCutsAdapter(client, fetch_url=fetch_url, objects=objects, records=records),
        paths=MEDIA_PATHS,
        image_models=frozenset({IMAGE_MODEL}),
        policy=policy,
    ).from_spec()


__all__ = [
    "FakeCutRecords",
    "FakeGenerations",
    "FakeObjects",
    "FakeUnderstanding",
    "Outcome",
    "mount_shot_video",
]
