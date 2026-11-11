from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import get_args

import httpx
from agent_runtime.file_store.store import FileSpace
from iclip_video.shot_video.capability import GenerationPolicy, ShotVideo
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.shot_video.ports import (
    ImageChannel,
    ImageGenerations,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    JobStatus,
)

from iclip.app.shot_media import FrameBoardsAdapter, GridCutsAdapter
from iclip.domains.generation.schemas import IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS
from iclip.platform.media.codec import MediaCodec
from tests.helpers.fetch_url import all_own

_ASPECT_RATIOS: frozenset[str] = frozenset(get_args(IMAGE_ASPECT_RATIOS))
_RESOLUTIONS: frozenset[str] = frozenset(get_args(IMAGE_RESOLUTIONS))


@dataclass(frozen=True, slots=True)
class Outcome:
    status: JobStatus = "completed"
    output_url: str | None = "https://cdn.test/out.png"
    error_code: str | None = None
    error_message: str | None = None


@dataclass
class FakeGenerations:
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
            status=outcome.status,
            channel=channel,
            output_url=outcome.output_url if outcome.status == "completed" else None,
            error_code=outcome.error_code,
            error_message=outcome.error_message,
        )

    def channels(self) -> list[str]:
        return [request.channel for request in self.submitted]


@dataclass
class FakeCutRecords:
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
    generations: ImageGenerations,
    objects: FakeObjects,
    records: FakeCutRecords,
    client: httpx.AsyncClient,
    fetch_url: Callable[[str], str],
    policy: GenerationPolicy,
    codec: MediaCodec,
) -> ShotVideo[object]:
    return ShotVideo.bind(
        space=space,
        generations=generations,
        boards=FrameBoardsAdapter(all_own(client, fetch_url), objects=objects, codec=codec),
        cuts=GridCutsAdapter(client, fetch_url=fetch_url, objects=objects, records=records),
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
