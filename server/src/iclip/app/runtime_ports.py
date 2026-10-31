"""对话域的几个运行时端口经运行时服务的 HTTP 接口实现：开会话、分叉与按清单拷文件（``RuntimeSessions``），
首页名册、起标题、按对话读活动与此刻在跑的对话。

应用身份由客户端的密钥定（后端是应用 ``video``），分叉与拷文件的 ``X-End-User`` 是目标对话的属主。运行时
答的 404、409、422 由客户端库还原成同类领域错误、``detail`` 与 ``code`` 原样，对话域的报错与进程内调用时一样；
答不上（含不认后端这个应用的 401、403）是 ``RuntimeUnavailable``，组合根装的错误处理器答 503。
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence

from agent_runtime.app_wire import (
    ActivitiesIn,
    FilesCopyIn,
    SessionForkIn,
    SessionOpenIn,
    TitleIn,
)
from agent_runtime.client import RuntimeClient
from agent_runtime.transcript.wire import SessionActivityOut

from iclip.domains.conversations.service import AgentDirectory, AgentEntry


class RuntimeServicePorts:
    """``open`` / ``fork`` / ``copy_files`` 合起来是对话域的 ``RuntimeSessions``；其余几个方法由组合根接成
    对应的端口。"""

    def __init__(self, client: RuntimeClient) -> None:
        self._client = client

    async def open(self, session_id: uuid.UUID, *, agent_id: str) -> None:
        await self._client.open_session(SessionOpenIn(id=session_id, agent_id=agent_id))

    async def fork(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None:
        await self._client.fork_session(
            source_id,
            SessionForkIn(
                target_id=target_id, source_user=source_user, turn=turn, agent_id=agent_id
            ),
            owner=target_user,
        )

    async def copy_files(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool:
        copied = await self._client.copy_files(
            source_id,
            FilesCopyIn(
                target_id=target_id,
                source_user=source_user,
                files=tuple(files),
                require_any=tuple(sorted(require_any)),
            ),
            owner=target_user,
        )
        return copied.copied

    async def list_agents(self) -> AgentDirectory:
        """``ListAgents``：运行时的首页名册。"""

        found = await self._client.agents()
        return AgentDirectory(
            items=tuple(AgentEntry(id=item.id, name=item.name) for item in found.items),
            default=found.default,
        )

    async def generate_title(self, user_text: str) -> str | None:
        """``GenerateTitle``：运行时用默认对话模型起标题，起不出为空。"""

        return (await self._client.generate_title(TitleIn(text=user_text))).title

    async def activities(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, SessionActivityOut]:
        """这几段对话在运行时那一侧的活动；运行时只答有会话的那些，没有会话的不在结果里。"""

        if not conversation_ids:
            return {}
        found = await self._client.activities(ActivitiesIn(ids=tuple(conversation_ids)))
        return found.items

    async def busy(self, owner: uuid.UUID | None) -> frozenset[uuid.UUID]:
        """``BusyConversationIds``：此刻占着执行位的对话；给属主就只算这个人的。"""

        return frozenset((await self._client.busy(owner=owner)).ids)


__all__ = ["RuntimeServicePorts"]
