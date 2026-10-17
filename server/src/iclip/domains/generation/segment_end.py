from __future__ import annotations

from typing import Final

# 浏览器读到的媒体时长与上游或 ffprobe 量出的隔着一次容器时长的取整，差不到一帧（24fps 约 42 毫秒）。
SEGMENT_END_TOLERANCE_MS: Final = 50

__all__ = ["SEGMENT_END_TOLERANCE_MS"]
