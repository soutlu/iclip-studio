"""生成记录的种类、操作与业务状态词表；属主是生成域，推送帧也引这一份。"""

from __future__ import annotations

from typing import Literal

GenerationKind = Literal["video", "image", "subtitle", "audio", "whole_film"]

GenerationOperation = Literal["generate", "compose", "cut", "upload", "render", "enhance"]

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]

VideoEnhanceResolution = Literal["720p", "1080p"]
"""高清版能提到的清晰度档，上游超分接口只收这两档；运行配置与提交端点共用。"""

__all__ = [
    "GenerationKind",
    "GenerationOperation",
    "GenerationStatus",
    "VideoEnhanceResolution",
]
