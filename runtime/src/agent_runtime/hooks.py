"""运行时回调应用：开跑检查（gate）、运行开始（run_started）与轮次开始（turn_started）。

按会话归属的应用找它配置的地址，``POST`` JSON 请求体，带 ``Authorization: Bearer <令牌>``；超过
``timeout_seconds`` 算超时。应用没配的回调不调。三个请求体的模型也给应用的回调处理器用。

- 开跑检查：应用答非 2xx、超时或连不上都抛 ``HookRejected``，这次运行照运行依赖构造失败的那条路记为失败。
- 运行开始与轮次开始：失败只记日志，不影响运行。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Literal

import httpx
import structlog

from agent_runtime.settings import ResolvedHooks
from agent_runtime.transcript.wire import Envelope, SessionActivityOut

_logger = structlog.stdlib.get_logger(__name__)

HookName = Literal["gate", "run_started", "turn_started"]


class GatePayload(Envelope):
    """开跑检查的请求体：这次运行跑的是哪段会话的哪条消息、以谁的身份、替谁。"""

    session_id: uuid.UUID
    owner_user_id: uuid.UUID
    user_name: str
    prompt_id: str
    run_id: str | None = None
    """这条消息上次挂上的运行（审批或崩溃后续跑时）；首次开跑为空。"""


class RunStartedPayload(Envelope):
    """运行开始的请求体：新运行的 id 与会话此刻的活动，应用不必再回查。"""

    session_id: uuid.UUID
    run_id: str
    activity: SessionActivityOut


class TurnStartedPayload(Envelope):
    """轮次开始的请求体：这一轮用户消息的文本部分（按换行连接），应用可拿它起标题。"""

    session_id: uuid.UUID
    text: str


class HookRejected(Exception):
    """开跑检查没通过：应用答了非 2xx、超时或连不上。"""


AppOf = Callable[[str], Awaitable[str | None]]
"""按会话 id 查它归哪个应用；没有这个会话给 ``None``。"""


class AppHooks:
    """按会话找应用、调它配置的回调。``hooks`` 按应用 id，没有回调的应用不在里面。"""

    def __init__(
        self,
        *,
        hooks: Mapping[str, ResolvedHooks],
        app_of: AppOf,
        client: httpx.AsyncClient,
    ) -> None:
        self._hooks = hooks
        self._app_of = app_of
        self._client = client

    async def gate(self, payload: GatePayload) -> None:
        """会话的应用配了开跑检查就等它答 2xx；不通过抛 ``HookRejected``。会话不存在也抛。"""

        session_id = str(payload.session_id)
        app_id = await self._app_of(session_id)
        if app_id is None:
            _logger.warning("开跑检查找不到会话归哪个应用", session_id=session_id)
            raise HookRejected("这段会话不存在")
        hooks = self._hooks.get(app_id)
        if hooks is None or hooks.gate is None:
            return
        try:
            status = await self._post(hooks, hooks.gate, payload)
        except (TimeoutError, httpx.HTTPError) as exc:
            _logger.warning(
                "开跑检查没有答复",
                hook="gate",
                app_id=app_id,
                session_id=session_id,
                error=type(exc).__name__,
            )
            raise HookRejected("开跑检查没有答复") from exc
        if not 200 <= status < 300:
            _logger.warning(
                "开跑检查没通过", hook="gate", app_id=app_id, session_id=session_id, status=status
            )
            raise HookRejected(f"开跑检查没通过：{status}")

    async def run_started(self, payload: RunStartedPayload) -> None:
        """会话的应用配了就通知一次运行开始，等它答完；失败只记日志。"""

        await self._notify("run_started", payload.session_id, payload)

    async def turn_started(self, payload: TurnStartedPayload) -> None:
        """会话的应用配了就通知一轮开始；失败只记日志。"""

        await self._notify("turn_started", payload.session_id, payload)

    async def _notify(self, name: HookName, session: uuid.UUID, payload: Envelope) -> None:
        session_id = str(session)
        try:
            app_id = await self._app_of(session_id)
        except Exception:
            _logger.exception("回调找不到会话归哪个应用", hook=name, session_id=session_id)
            return
        hooks = None if app_id is None else self._hooks.get(app_id)
        url = None if hooks is None else _url_of(hooks, name)
        if hooks is None or url is None:
            return
        try:
            status = await self._post(hooks, url, payload)
        except (TimeoutError, httpx.HTTPError) as exc:
            _logger.warning(
                "回调应用没有答复",
                hook=name,
                app_id=app_id,
                session_id=session_id,
                error=type(exc).__name__,
            )
            return
        if not 200 <= status < 300:
            _logger.warning(
                "回调应用没成功", hook=name, app_id=app_id, session_id=session_id, status=status
            )

    async def _post(self, hooks: ResolvedHooks, url: str, payload: Envelope) -> int:
        """发一次回调，交回状态码；超时抛 ``TimeoutError``，连不上抛 ``httpx.HTTPError``。"""

        # 超时由这里统一掐：传输层自己的超时不一定生效（测试替身、代理），整次请求一并算。
        async with asyncio.timeout(hooks.timeout_seconds):
            response = await self._client.post(
                url,
                content=payload.model_dump_json(),
                headers={
                    "Authorization": f"Bearer {hooks.token}",
                    "Content-Type": "application/json",
                },
                timeout=hooks.timeout_seconds,
            )
        return response.status_code


def _url_of(hooks: ResolvedHooks, name: HookName) -> str | None:
    match name:
        case "gate":
            return hooks.gate
        case "run_started":
            return hooks.run_started
        case "turn_started":
            return hooks.turn_started


__all__ = [
    "AppHooks",
    "AppOf",
    "GatePayload",
    "HookName",
    "HookRejected",
    "RunStartedPayload",
    "TurnStartedPayload",
]
