"""视频拆解的端口走 HTTP 时的请求与答复：宿主给运行时的内部接口照它解析与回答，插件的 HTTP 客户端照它
发请求、取回结果，两边共用这一份。字段名 snake_case 原样；路径、状态码与报错写在
contract/conventions.md「后端给运行时的内部接口」。"""

from __future__ import annotations

import uuid
from typing import Self

from pydantic import BaseModel, ConfigDict, model_validator

from iclip_video.video_breakdown.ports import FailedBreakdown


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ReferenceBreakdownCall(_Wire):
    """要一条参考视频的拆解，参数同 ``ReferenceBreakdowns.ensure``；``user_id`` 是运行属主。"""

    user_id: uuid.UUID
    video_url: str


class ReferenceBreakdownResult(_Wire):
    """拆解的结果：拆成了带 ``document``，没拆成带 ``failed``，恰好一个。"""

    document: str | None = None
    failed: FailedBreakdown | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> Self:
        if (self.document is None) == (self.failed is None):
            raise ValueError("document 与 failed 恰好给一个")
        return self

    @classmethod
    def of(cls, outcome: str | FailedBreakdown) -> Self:
        """宿主把端口的返回值写成答复。"""

        if isinstance(outcome, FailedBreakdown):
            return cls(failed=outcome)
        return cls(document=outcome)

    def outcome(self) -> str | FailedBreakdown:
        """客户端还原成端口的返回值。"""

        if self.failed is not None:
            return self.failed
        if self.document is None:
            raise AssertionError("校验器保证 document 与 failed 恰好给一个")
        return self.document


__all__ = ["ReferenceBreakdownCall", "ReferenceBreakdownResult"]
