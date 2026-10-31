"""会话服务：开会话、分叉与按清单拷文件，应用经它操作运行时的会话、工作区、素材台账与快照。

会话 id 等于应用那一侧的对话 id；工作区与素材台账的命名空间是「属主/会话 id」，所以两端的属主都要给。
会话归开它的应用（``app_id`` 是接入应用的标识）：别的应用问到它与问到不存在的会话一样是 ``NotFound``，
同一个 id 也不能被别的应用开走。
几处写入各开各的事务，没有统一回滚：应用在这些都写完之后才落自己的记录，中途失败只留下寻址不到的数据。

拷进新会话的文件走 ``FileStore`` 的写入口：容量上限与路径校验照旧生效。给它的存储不能是会发文件变更帧
的那一层：新会话在应用那一侧还没有记录，这一刻没人订阅得了它。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Collection, Sequence
from typing import Final, Protocol

from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import FileStore
from agent_runtime.harness.jobs import JobQueueView
from agent_runtime.material_ledger.store import Material

SESSION_NOT_FOUND: Final = "没有这段会话"
"""会话不在、或归别的应用时的报错：两种说法一样，不让别的应用看出这个 id 有人用。"""

SESSION_ID_TAKEN: Final = "这个会话 id 已经被别的应用用了，换一个"


class SessionStore(Protocol):
    """会话表：会话归哪个应用、固定的 agent 版本。"""

    async def open(
        self, session_id: uuid.UUID, *, app_id: str, agent_version_id: uuid.UUID | None
    ) -> bool:
        """开会话；这个 id 已归别的应用时什么都不写、回 ``False``。"""
        ...

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID, *, app_id: str) -> bool:
        """照抄源的版本开会话；目标 id 已归别的应用时什么都不写、回 ``False``。"""
        ...

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]: ...


VersionForNewSession = Callable[[str], Awaitable[uuid.UUID]]
"""新会话要固定的版本：这个 agent 的当前版本。没有这个 agent 或它不上菜单是 ``ValidationFailed``，
已归档或还没发布过是 ``Conflict``。"""


class SessionQueue(Protocol):
    """会话的消息队列：此刻占着执行位置与排着队的消息。"""

    async def view(self, conversation_id: str) -> JobQueueView: ...


class SeedPlan(Protocol):
    """规划好、还没写的分叉起点。"""

    async def commit(self) -> None: ...


class ForkHistory(Protocol):
    """会话历史：一共几轮，与截到某一轮的分叉起点。"""

    async def turn_count(self, conversation_id: str) -> int: ...

    async def plan_fork(
        self, conversation_id: str, *, ordinal: int, target_conversation_id: str
    ) -> SeedPlan | None: ...


class WholeLedger(Protocol):
    """素材台账的登记与整份读出。"""

    async def record(self, namespace: str, materials: Sequence[Material]) -> None: ...

    async def list_all(self, namespace: str) -> Sequence[Material]: ...


class SessionService:
    """应用开会话、分叉与拷文件的入口。"""

    def __init__(
        self,
        *,
        sessions: SessionStore,
        version_for_new_session: VersionForNewSession,
        queue: SessionQueue,
        history: ForkHistory,
        files: FileStore,
        ledger: WholeLedger,
    ) -> None:
        self._sessions = sessions
        self._version_for_new_session = version_for_new_session
        self._queue = queue
        self._history = history
        self._files = files
        self._ledger = ledger

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]:
        """``session_ids`` 里归 ``app_id`` 的那些；不存在的与别的应用的都不在结果里。"""

        return await self._sessions.owned(session_ids, app_id=app_id)

    async def require_owned(self, session_id: uuid.UUID, *, app_id: str) -> None:
        """会话不存在、或不归 ``app_id`` 都是 ``NotFound``，两种报错一样。"""

        if session_id not in await self._sessions.owned((session_id,), app_id=app_id):
            raise NotFound(SESSION_NOT_FOUND)

    async def open(self, session_id: uuid.UUID, *, app_id: str, agent_id: str) -> None:
        """给 ``app_id`` 开会话，固定这个 agent 此刻的当前版本。

        没有这个 agent、或它不上首页菜单是 ``ValidationFailed``；已归档、还没发布过是 ``Conflict``。
        这个 id 已有同一应用的会话就按这次的版本改写：应用只在自己还没有记录时开会话。这个 id 已归别的
        应用是 ``Conflict``：id 由应用自己铸，撞上了换一个就行。"""

        version_id = await self._version_for_new_session(agent_id)
        if not await self._sessions.open(session_id, app_id=app_id, agent_version_id=version_id):
            raise Conflict(SESSION_ID_TAKEN)

    async def fork(
        self,
        *,
        app_id: str,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None:
        """从源会话的第 ``turn`` 轮分叉出归 ``app_id`` 的新会话：固定版本、拷工作区文件与整份素材台账、
        写种子快照。

        源不归 ``app_id`` 是 ``NotFound``，最先查，报错同会话不存在。``agent_id`` 为 None 照抄源会话的
        版本，否则按 ``open`` 固定那个 agent 的当前版本、照它抛错；目标 id 已归别的应用是 ``Conflict``。
        源有没跑完或排着队的消息是 ``Conflict``：排队的那条一旦起跑就会写新快照，轮号跟着变。源没跑过、
        或 ``turn`` 超出它的轮数是 ``ValidationFailed``，都在拷任何东西之前。数完轮数之后源又跑了一轮，
        写种子快照时是 ``Conflict``，那时会话、文件与素材已经写了。

        种子快照里的 run_id 照抄源会话：新会话靠它们回源查每轮的终态与子代理，不另存运行记录。"""

        # 先认归属：别的应用不该从「在忙」「只有几轮」这些报错里看出这个会话存在。
        await self.require_owned(source_id, app_id=app_id)
        view = await self._queue.view(str(source_id))
        if view.active is not None or view.queued:
            raise Conflict("这段对话还有没跑完的消息，等它收完尾再分叉")
        turns = await self._history.turn_count(str(source_id))
        if turns == 0:
            raise ValidationFailed("这段对话还没跑过，没有可分叉的轮次")
        if turn > turns:
            raise ValidationFailed(f"这段对话只有 {turns} 轮，分不出第 {turn} 轮")
        if agent_id is None:
            if not await self._sessions.copy(source_id, target_id, app_id=app_id):
                raise Conflict(SESSION_ID_TAKEN)
        else:
            await self.open(target_id, app_id=app_id, agent_id=agent_id)
        source = namespace_for(source_user, str(source_id))
        target = namespace_for(target_user, str(target_id))
        for entry in await self._files.entries(source):
            found = await self._files.read(source, entry.path)
            if found is None:
                # 列得出来却读不出来，只可能是绕过存储写进去的非规范路径：不静默少拷一个文件。
                raise RuntimeError(f"工作区列出了 {entry.path} 却读不出来，这段对话的文件存坏了")
            await self._files.write(target, entry.path, found.content)
        await self._copy_ledger(source, target)
        seed = await self._history.plan_fork(
            str(source_id), ordinal=turn, target_conversation_id=str(target_id)
        )
        if seed is None:
            # 先数过轮数才动手拷的，走到这儿说明源在这期间又跑了一轮。
            raise Conflict("这段对话刚刚又跑了一轮，重新挑一个分叉点")
        await seed.commit()

    async def copy_files(
        self,
        *,
        app_id: str,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool:
        """按清单把源会话工作区里的几份文件拷进目标会话，连同整份素材台账。

        源与目标都要是 ``app_id`` 的会话（目标由应用先开好），任一不是都是 ``NotFound``，报错同会话不存在，
        在读写任何东西之前。``files`` 是（源路径，目标路径），源里没有的跳过。``require_any`` 里的源路径一个都不在时什么都
        不写、回 ``False``；不在 ``files`` 里的路径算不在；``require_any`` 为空即没有这个前提，照拷。台账
        整份跟着拷：拷过去的文件引用的地址都登记在台账里，目标会话靠它认得这些地址。"""

        await self.require_owned(source_id, app_id=app_id)
        await self.require_owned(target_id, app_id=app_id)
        source = namespace_for(source_user, str(source_id))
        found = {path: await self._files.read(source, path) for path, _ in files}
        if require_any and all(found.get(path) is None for path in require_any):
            return False
        target = namespace_for(target_user, str(target_id))
        for path, renamed in files:
            stored = found[path]
            if stored is not None:
                await self._files.write(target, renamed, stored.content)
        await self._copy_ledger(source, target)
        return True

    async def _copy_ledger(self, source: str, target: str) -> None:
        await self._ledger.record(target, await self._ledger.list_all(source))


__all__ = [
    "SESSION_ID_TAKEN",
    "SESSION_NOT_FOUND",
    "ForkHistory",
    "SeedPlan",
    "SessionQueue",
    "SessionService",
    "SessionStore",
    "VersionForNewSession",
    "WholeLedger",
]
