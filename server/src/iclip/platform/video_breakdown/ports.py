from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class BreakdownError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class BreakdownModelUnavailable(BreakdownError):
    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=False)


@dataclass(frozen=True, slots=True)
class SampledVideo:
    frames: tuple[bytes, ...]

    audio: bytes | None


class VideoSampler(Protocol):
    async def sample_up_to(self, video_url: str, *, max_seconds: float) -> SampledVideo | None: ...


__all__ = [
    "BreakdownError",
    "BreakdownModelUnavailable",
    "SampledVideo",
    "VideoSampler",
]
