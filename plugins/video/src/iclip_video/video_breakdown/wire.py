from __future__ import annotations

import uuid
from typing import Self

from pydantic import BaseModel, ConfigDict, model_validator

from iclip_video.video_breakdown.ports import FailedBreakdown


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ReferenceBreakdownCall(_Wire):
    user_id: uuid.UUID
    video_url: str


class ReferenceBreakdownResult(_Wire):
    document: str | None = None
    failed: FailedBreakdown | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> Self:
        if (self.document is None) == (self.failed is None):
            raise ValueError("document 与 failed 恰好给一个")
        return self

    @classmethod
    def of(cls, outcome: str | FailedBreakdown) -> Self:
        if isinstance(outcome, FailedBreakdown):
            return cls(failed=outcome)
        return cls(document=outcome)

    def outcome(self) -> str | FailedBreakdown:
        if self.failed is not None:
            return self.failed
        if self.document is None:
            raise AssertionError("校验器保证 document 与 failed 恰好给一个")
        return self.document


__all__ = ["ReferenceBreakdownCall", "ReferenceBreakdownResult"]
