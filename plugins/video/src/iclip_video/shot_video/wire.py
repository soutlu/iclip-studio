"""取帧与出图的端口走 HTTP 时的请求与答复：宿主给运行时的内部接口照它解析与回答，插件的 HTTP 客户端照它
发请求、把失败还原成端口声明的错误，两边共用这一份。

字段名 snake_case 原样；里面装的端口模型（``ImageRequest``、``ImageJob``、``ShotSpan``、
``BoardsResult``）照它们自己的形状，``ExtractionLedger`` 的字段按它的 camelCase 别名。路径、状态码与
报错写在 contract/conventions.md「后端给运行时的内部接口」。"""

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
    """提交一次出图：``user_id`` 是运行属主，宿主按它重建主体。答复是 ``ImageJob``。"""

    user_id: uuid.UUID
    request: ImageRequest


class FrameBoardsCall(_Wire):
    """取帧拼板，参数同 ``FrameBoards.boards``。答复是 ``BoardsResult``。"""

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
    """取帧拼板没成（422）：``detail`` 是给模型的原话，``code`` 认出是 ``FrameBoardsFailed`` 的哪个子类。"""

    detail: str
    code: FrameBoardsFailureCode

    @classmethod
    def of(cls, error: FrameBoardsFailed) -> Self:
        """宿主把端口抛的错误写成答复。

        Raises:
            TypeError: 错误不是三个子类之一（端口实现只该抛子类）。
        """

        for code, kind in _BOARDS_FAILURES:
            if isinstance(error, kind):
                return cls(detail=str(error), code=code)
        raise TypeError(f"取帧拼板的错误 {type(error).__name__} 不是端口声明的子类")

    def error(self) -> FrameBoardsFailed:
        """客户端把答复还原成端口声明的同一个错误子类，``str()`` 就是 ``detail``。"""

        return next(kind for code, kind in _BOARDS_FAILURES if code == self.code)(self.detail)


class GridCutCall(_Wire):
    """切一张宫格，参数同 ``GridCuts.cut``；``user_id`` 是运行属主，``job_id`` 是这张宫格的出图任务。"""

    user_id: uuid.UUID
    job_id: uuid.UUID
    grid_url: str
    cells: CutCells
    aspect: str | None = None


class GridCutResult(_Wire):
    """转存后的地址，与 ``cells`` 同序。"""

    urls: tuple[str, ...]


GRID_CUT_FAILED: Final = "grid_cut_failed"


class GridCutFailure(_Wire):
    """切格没成（422）：``detail`` 是 ``GridCutFailed`` 的诊断原因，只进日志。"""

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
