from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class ModelConnection:
    responses_url: str

    api_key: str = field(repr=False)


ModelConnectionLookup = Callable[[str, str], Awaitable[ModelConnection]]


__all__ = ["ModelConnection", "ModelConnectionLookup"]
