from __future__ import annotations

import uuid
from typing import Final, Literal, Self

from pydantic import BaseModel, ConfigDict

from iclip_video.shot_video.ports import (
    BoardsNotStored,
    BoardsUnreadable,
    CutCells,
    ExtractionLedger,
    FrameBoardsFailed,
    ImageRequest,
    ShotsOutOfRange,
)
from iclip_video.shot_video.shots import ShotSpan


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ImageSubmission(_Wire):
    user_id: uuid.UUID
    request: ImageRequest


class FrameBoardsCall(_Wire):
    video_url: str
    rows: tuple[tuple[ShotSpan, ...], ...]
    previous: ExtractionLedger | None = None


FrameBoardsFailureCode = Literal["shots_out_of_range", "boards_unreadable", "boards_not_stored"]

_BOARDS_FAILURES: Final[tuple[tuple[FrameBoardsFailureCode, type[FrameBoardsFailed]], ...]] = (
    ("shots_out_of_range", ShotsOutOfRange),
    ("boards_unreadable", BoardsUnreadable),
    ("boards_not_stored", BoardsNotStored),
)


class FrameBoardsFailure(_Wire):
    detail: str
    code: FrameBoardsFailureCode

    @classmethod
    def of(cls, error: FrameBoardsFailed) -> Self:
        for code, kind in _BOARDS_FAILURES:
            if isinstance(error, kind):
                return cls(detail=str(error), code=code)
        raise TypeError(f"取帧拼板的错误 {type(error).__name__} 不是端口声明的子类")

    def error(self) -> FrameBoardsFailed:
        return next(kind for code, kind in _BOARDS_FAILURES if code == self.code)(self.detail)


class GridCutCall(_Wire):
    user_id: uuid.UUID
    job_id: uuid.UUID
    grid_url: str
    cells: CutCells
    aspect: str | None = None


class GridCutResult(_Wire):
    urls: tuple[str, ...]


GRID_CUT_FAILED: Final = "grid_cut_failed"


class GridCutFailure(_Wire):
    detail: str
    code: Literal["grid_cut_failed"] = GRID_CUT_FAILED


__all__ = [
    "GRID_CUT_FAILED",
    "FrameBoardsCall",
    "FrameBoardsFailure",
    "FrameBoardsFailureCode",
    "GridCutCall",
    "GridCutFailure",
    "GridCutResult",
    "ImageSubmission",
]
