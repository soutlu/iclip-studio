from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol


class InvalidNodeImageRequest(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class NodeImageRequest:
    node: str

    prompt: str
    model: str
    aspect_ratio: str
    resolution: str
    reference_image_urls: tuple[str, ...]
    user_name: str

    conversation_id: str


@dataclass(frozen=True, slots=True)
class NodeImageJob:
    job_id: uuid.UUID
    status: Literal["pending", "submitting", "submitted", "completed", "failed"]
    output_url: str | None = None
    error_message: str | None = None

    @property
    def finished(self) -> bool:
        return self.status in ("completed", "failed")


class NodeImages(Protocol):
    async def submit(self, user_id: uuid.UUID, request: NodeImageRequest) -> NodeImageJob: ...

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> NodeImageJob: ...


__all__ = [
    "InvalidNodeImageRequest",
    "NodeImageJob",
    "NodeImageRequest",
    "NodeImages",
]
