"""生成记录的种类、操作与业务状态词表；属主是生成域，推送帧也引这一份。"""

from __future__ import annotations

from typing import Literal

GenerationKind = Literal["video", "image", "subtitle", "audio"]

GenerationOperation = Literal["generate", "compose", "cut", "upload"]

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]

__all__ = ["GenerationKind", "GenerationOperation", "GenerationStatus"]
