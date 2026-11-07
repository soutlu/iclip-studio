from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Final, Literal

import httpx
import structlog

from cue.errors import HookRejected
from cue.settings import ResolvedHooks
from cue.transcript.wire import Envelope, SessionActivityOut

_logger = structlog.stdlib.get_logger(__name__)

HookName = Literal["gate", "run_started", "turn_started"]


class GatePayload(Envelope):
    session_id: uuid.UUID
    owner_user_id: uuid.UUID
    user_name: str
    prompt_id: str
    run_id: str | None = None
    preview: bool = False


class RunStartedPayload(Envelope):
    session_id: uuid.UUID
    run_id: str
    activity: SessionActivityOut
    preview: bool = False


class TurnStartedPayload(Envelope):
    session_id: uuid.UUID
    text: str
    preview: bool = False


FIRST_RETRY_SECONDS: Final = 0.5
MAX_RETRY_SECONDS: Final = 5.0
RETRY_WINDOW_SECONDS: Final = 30.0

_TRANSIENT_STATUSES: Final = frozenset({502, 503, 504})

AppOf = Callable[[str], Awaitable[str | None]]


class AppHooks:
    def __init__(
        self,
        *,
        hooks: Mapping[str, ResolvedHooks],
        app_of: AppOf,
        client: httpx.AsyncClient,
        first_retry_seconds: float = FIRST_RETRY_SECONDS,
        max_retry_seconds: float = MAX_RETRY_SECONDS,
        retry_window_seconds: float = RETRY_WINDOW_SECONDS,
    ) -> None:
        self._hooks = hooks
        self._app_of = app_of
        self._client = client
        self._first_retry = first_retry_seconds
        self._max_retry = max_retry_seconds
        self._retry_window = retry_window_seconds

    async def gate(self, payload: GatePayload) -> None:
        session_id = str(payload.session_id)
        app_id = await self._app_of(session_id)
        if app_id is None:
            _logger.warning("开跑检查找不到会话归哪个应用", session_id=session_id)
            raise HookRejected("这段会话不存在")
        hooks = self._hooks.get(app_id)
        if hooks is None or hooks.gate is None:
            return
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._retry_window
        wait = self._first_retry
        while True:
            try:
                status = await self._post(hooks, hooks.gate, payload)
            except (TimeoutError, httpx.HTTPError) as exc:
                failure, status, error, cause = "没有答复", None, type(exc).__name__, exc
            else:
                if 200 <= status < 300:
                    return
                if status not in _TRANSIENT_STATUSES:
                    _logger.warning(
                        "开跑检查没通过",
                        hook="gate",
                        app_id=app_id,
                        session_id=session_id,
                        status=status,
                    )
                    raise HookRejected(f"开跑检查没通过：答了 {status}")
                failure, error, cause = f"答了 {status}", None, None
            if loop.time() + wait >= deadline:
                _logger.warning(
                    "开跑检查重试到期仍没放行",
                    hook="gate",
                    app_id=app_id,
                    session_id=session_id,
                    status=status,
                    error=error,
                    window_seconds=self._retry_window,
                )
                raise HookRejected(
                    f"开跑检查 {self._retry_window:g} 秒内一直没放行，最后一次{failure}"
                ) from cause
            _logger.warning(
                "开跑检查暂时没放行，稍后重试",
                hook="gate",
                app_id=app_id,
                session_id=session_id,
                status=status,
                error=error,
                retry_seconds=wait,
            )
            await asyncio.sleep(wait)
            wait = min(wait * 2, self._max_retry)

    async def run_started(self, payload: RunStartedPayload) -> None:
        await self._notify("run_started", payload.session_id, payload)

    async def turn_started(self, payload: TurnStartedPayload) -> None:
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
    "FIRST_RETRY_SECONDS",
    "MAX_RETRY_SECONDS",
    "RETRY_WINDOW_SECONDS",
    "AppHooks",
    "AppOf",
    "GatePayload",
    "HookName",
    "RunStartedPayload",
    "TurnStartedPayload",
]
