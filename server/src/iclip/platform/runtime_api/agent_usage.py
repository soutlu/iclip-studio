from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class AgentUsageOut(BaseModel):
    """接口里 ``usedBy`` 的一项：一个在用的 agent，草稿或当前版本里引用了。"""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )

    agent_id: str
    agent_name: str
    in_draft: bool
    in_active_version: bool


__all__ = [
    "AgentUsageOut",
]
