from __future__ import annotations

from collections.abc import Sequence
from typing import Final

import structlog
from cue.file_store.store import FileStore
from pydantic import ValidationError
from pydantic_ai import ModelRetry

from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    ExtractionLedger,
    FrameBoards,
    FrameBoardsFailed,
)
from iclip_video.shot_video.shots import (
    SHOT_TIMECODE_SHAPE,
    ShotParseError,
    ShotSpan,
    parse_shot_rows,
)

EXTRACTION_PATH: Final = "frames/extraction.json"

_logger = structlog.stdlib.get_logger(__name__)


class FrameExtractor:
    def __init__(self, *, boards: FrameBoards) -> None:
        self._boards = boards

    async def shot_rows(
        self, files: FileStore, namespace: str, doc_path: str
    ) -> tuple[tuple[ShotSpan, ...], ...]:
        stored = await files.read(namespace, doc_path)
        if stored is None:
            raise ModelRetry(f"参考视频拆解文档 {doc_path} 不存在，先对该视频调用 video_parser。")
        try:
            return parse_shot_rows(stored.content)
        except ShotParseError as exc:
            raise ModelRetry(
                f"参考视频拆解文档 {doc_path} 解析失败：{exc}。用 edit_file 就地把该时间码改成 "
                f"{SHOT_TIMECODE_SHAPE} 形状（只改时间码，不动正文）后重新调用；整份文档都读"
                f"不出时改为对该视频重新调用 video_parser。"
            ) from exc

    async def ledger(
        self,
        files: FileStore,
        namespace: str,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
    ) -> tuple[ExtractionLedger, bool]:
        try:
            result = await self._boards.boards(
                video_url=video_url, rows=rows, previous=await self.load(files, namespace)
            )
        except FrameBoardsFailed as exc:
            raise ModelRetry(str(exc)) from exc
        return result.ledger, result.reused

    async def load(self, files: FileStore, namespace: str) -> ExtractionLedger | None:
        stored = await files.read(namespace, EXTRACTION_PATH)
        if stored is None:
            return None
        try:
            document = ExtractionLedger.model_validate_json(stored.content)
        except ValidationError as exc:
            _logger.warning(
                "取帧台账形状不合，按不存在处理", namespace=namespace, errors=exc.error_count()
            )
            return None
        if document.extraction_version != EXTRACTION_VERSION:
            return None
        return document


__all__ = [
    "EXTRACTION_PATH",
    "FrameExtractor",
]
