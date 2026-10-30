"""对话分叉的适配：生成域读副本继承的出片要的血缘接到对话域上。分叉本身的会话、工作区、素材与种子
快照由运行时的会话服务写。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.identity.public import Principal

ConversationReadable = Callable[[Principal, uuid.UUID], Awaitable[bool]]
"""主体读不读得到这段对话；由组合根接到对话服务上。"""


class ForkLineageAdapter:
    """生成域的 ``ConversationLineage``：祖先与边界问对话的 Postgres 仓储，读不读得到问对话服务。

    递归查询只在具体仓储上，不进对话仓储协议。对话服务在生成模块之后才装配，可读判断由组合根
    以闭包在调用时才取。"""

    def __init__(
        self, *, conversations: SqlConversationRepository, readable: ConversationReadable
    ) -> None:
        self._conversations = conversations
        self._readable = readable

    async def ancestry(self, conversation_id: uuid.UUID) -> tuple[tuple[uuid.UUID, datetime], ...]:
        return await self._conversations.ancestry(conversation_id)

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        return await self._readable(principal, conversation_id)


__all__ = ["ForkLineageAdapter"]
