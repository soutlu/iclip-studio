from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field

from agent_runtime.file_store.store import FileSpace

from iclip_video.shot_video.capability import GenerationPolicy, ShotVideo
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    AnchorSheets,
    BoardsResult,
    ExtractionLedger,
    ImageChannel,
    ImageGenerations,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    LedgerBoard,
    ShotCells,
)
from iclip_video.shot_video.shots import ShotSpan

_ASPECT_RATIOS = frozenset({"1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"})

_RESOLUTIONS = frozenset({"1k", "2k", "4k"})


@dataclass(frozen=True, slots=True)
class Outcome:
    status: str = "completed"
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
            status=outcome.status,  # type: ignore[arg-type]
            channel=channel,
            output_url=outcome.output_url if outcome.status == "completed" else None,
            error_code=outcome.error_code,
            error_message=outcome.error_message,
        )

    def channels(self) -> list[str]:
        return [request.channel for request in self.submitted]


def board_url(index: int = 1, *, key: str = "k") -> str:
    return f"https://cdn.test/boards/{key}/{index}.jpg"


@dataclass(frozen=True, slots=True)
class BoardsCall:
    video_url: str
    rows: tuple[tuple[ShotSpan, ...], ...]
    previous: ExtractionLedger | None


@dataclass
class FakeBoards:
    calls: list[BoardsCall] = field(default_factory=list[BoardsCall])
    error: Exception | None = None

    async def boards(
        self,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
        previous: ExtractionLedger | None,
    ) -> BoardsResult:
        self.calls.append(
            BoardsCall(
                video_url=video_url, rows=tuple(tuple(row) for row in rows), previous=previous
            )
        )
        if self.error is not None:
            raise self.error
        if previous is not None:
            return BoardsResult(ledger=previous, reused=True)
        built = ExtractionLedger(
            extraction_version=EXTRACTION_VERSION,
            extraction_key="k",
            boards=[
                LedgerBoard(board=index, url=board_url(index)) for index in range(1, len(rows) + 1)
            ],
        )
        return BoardsResult(ledger=built, reused=False)


@dataclass(frozen=True, slots=True)
class CutCall:
    user_id: uuid.UUID
    job_id: uuid.UUID
    grid_url: str
    cells: ShotCells | AnchorSheets
    aspect: str | None


def cut_url(job_id: uuid.UUID, cell: str | int) -> str:
    return f"https://cdn.test/cuts/{job_id}/{cell}.jpg"


@dataclass
class FakeCuts:
    calls: list[CutCall] = field(default_factory=list[CutCall])
    error: Exception | None = None

    async def cut(
        self,
        user_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        grid_url: str,
        cells: ShotCells | AnchorSheets,
        aspect: str | None,
    ) -> tuple[str, ...]:
        self.calls.append(
            CutCall(user_id=user_id, job_id=job_id, grid_url=grid_url, cells=cells, aspect=aspect)
        )
        if self.error is not None:
            raise self.error
        names = cells.cell_ids if isinstance(cells, ShotCells) else cells.indexes
        return tuple(cut_url(job_id, name) for name in names)


def mount_shot_video(
    *,
    space: FileSpace,
    generations: ImageGenerations,
    boards: FakeBoards,
    cuts: FakeCuts,
    policy: GenerationPolicy,
) -> ShotVideo[object]:
    return ShotVideo.bind(
        space=space,
        generations=generations,
        boards=boards,
        cuts=cuts,
        image_models=frozenset({IMAGE_MODEL}),
        policy=policy,
    ).from_spec()


__all__ = [
    "BoardsCall",
    "CutCall",
    "FakeBoards",
    "FakeCuts",
    "FakeGenerations",
    "Outcome",
    "board_url",
    "cut_url",
    "mount_shot_video",
]
