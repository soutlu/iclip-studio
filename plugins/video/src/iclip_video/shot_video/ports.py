from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated, Final, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip_video.shot_video.shots import ShotSpan

ImageChannel = Literal["dev", "pro"]

JobStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]

EXTRACTION_VERSION: Final = 1


class InvalidImageRequest(ValueError):
    pass


class ImageJobUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ImageRequest:
    prompt: str
    model: str

    aspect_ratio: str
    resolution: str
    channel: ImageChannel
    user_name: str
    reference_image_urls: tuple[str, ...] = ()
    conversation_id: str | None = None


@dataclass(frozen=True, slots=True)
class ImageJob:
    job_id: uuid.UUID
    status: JobStatus
    channel: ImageChannel
    output_url: str | None = None
    error_code: str | None = None
    error_message: str | None = None

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "failed")


class ImageGenerations(Protocol):
    async def submit(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob: ...

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob: ...


class LedgerBoard(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    board: Annotated[int, Field(strict=True, ge=1)]
    url: str


class ExtractionLedger(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )

    extraction_version: int
    extraction_key: str
    boards: list[LedgerBoard]


@dataclass(frozen=True, slots=True)
class BoardsResult:
    ledger: ExtractionLedger
    reused: bool


class FrameBoardsFailed(Exception):
    pass


class ShotsOutOfRange(FrameBoardsFailed):
    pass


class BoardsUnreadable(FrameBoardsFailed):
    pass


class BoardsNotStored(FrameBoardsFailed):
    pass


class FrameBoards(Protocol):
    async def boards(
        self,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
        previous: ExtractionLedger | None,
    ) -> BoardsResult: ...


class GridCutFailed(Exception):
    pass


class ShotCells(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["shot_cells"] = "shot_cells"
    cell_ids: tuple[str, ...] = Field(min_length=1)


class AnchorSheets(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["anchor_sheets"] = "anchor_sheets"
    indexes: tuple[Annotated[int, Field(strict=True, ge=1)], ...] = Field(min_length=1)


CutCells = Annotated[ShotCells | AnchorSheets, Field(discriminator="kind")]


class GridCuts(Protocol):
    async def cut(
        self,
        user_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        grid_url: str,
        cells: ShotCells | AnchorSheets,
        aspect: str | None,
    ) -> tuple[str, ...]: ...


__all__ = [
    "EXTRACTION_VERSION",
    "AnchorSheets",
    "BoardsNotStored",
    "BoardsResult",
    "BoardsUnreadable",
    "CutCells",
    "ExtractionLedger",
    "FrameBoards",
    "FrameBoardsFailed",
    "GridCutFailed",
    "GridCuts",
    "ImageChannel",
    "ImageGenerations",
    "ImageJob",
    "ImageJobUnavailable",
    "ImageRequest",
    "InvalidImageRequest",
    "JobStatus",
    "LedgerBoard",
    "ShotCells",
    "ShotsOutOfRange",
]
