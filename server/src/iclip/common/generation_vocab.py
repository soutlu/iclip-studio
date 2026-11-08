from __future__ import annotations

from typing import Literal

GenerationKind = Literal["video", "image", "subtitle", "audio", "whole_film"]

GenerationOperation = Literal["generate", "compose", "cut", "upload", "render", "enhance"]

GenerationStatus = Literal["pending", "submitting", "submitted", "completed", "failed"]

VideoEnhanceResolution = Literal["720p", "1080p"]

__all__ = [
    "GenerationKind",
    "GenerationOperation",
    "GenerationStatus",
    "VideoEnhanceResolution",
]
