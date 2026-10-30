from __future__ import annotations

from typing import Final

from agent_runtime.errors import ValidationFailed
from iclip_video.shot_prompt import format_seconds

# 浏览器读到的媒体时长与上游或 ffprobe 量出的隔着一次容器时长的取整，差不到一帧（24fps 约 42 毫秒）。
SEGMENT_END_TOLERANCE_MS: Final = 50


def exceeds_source(end_ms: int, source_ms: int) -> bool:
    return end_ms > source_ms + SEGMENT_END_TOLERANCE_MS


def check_segment_end(position: int, end_ms: int, source_ms: int | None) -> None:
    if source_ms is not None and exceeds_source(end_ms, source_ms):
        raise ValidationFailed(
            f"第 {position} 段的结尾 {format_seconds(end_ms / 1000)} 秒超出了那条记录的时长 "
            f"{format_seconds(source_ms / 1000)} 秒"
        )


__all__ = ["SEGMENT_END_TOLERANCE_MS", "check_segment_end", "exceeds_source"]
