"""运行统计接口：给应用的报表取事实行（消息、跑到终态的顶层运行、按模型的累计用量、每段会话的首末消息）。

只读，只答调用方应用自己的会话；不认识用户与业务对象，聚合由应用自己做。按时间窗或按会话取，二选一，
按会话一次最多 ``MAX_STATS_SESSIONS`` 段。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends

from agent_runtime.app_wire import (
    PromptStatOut,
    PromptStatsOut,
    RunStatOut,
    RunStatsOut,
    SessionStatOut,
    SessionStatsOut,
    StatsQueryIn,
    StatsSessionsIn,
    UsageStatOut,
    UsageStatsOut,
)
from agent_runtime.harness.stats_pg import PgRunStats, StatsScope, StatsWindow
from agent_runtime.http.auth import CallingApp


def _scope(body: StatsQueryIn) -> StatsScope:
    if body.session_ids is not None:
        return body.session_ids
    if body.since is None:
        # 请求体的校验已挡掉：按时间窗取一定带 since。
        raise ValueError("按时间窗取要给 since")
    return StatsWindow(since=body.since, until=body.until)


def create_stats_router(
    stats: PgRunStats, calling_app: Callable[..., Awaitable[CallingApp]]
) -> APIRouter:
    router = APIRouter(prefix="/stats", tags=["stats"])
    caller = Depends(calling_app)

    @router.post("/prompts", response_model=PromptStatsOut)
    async def prompts(body: StatsQueryIn, app: CallingApp = caller) -> PromptStatsOut:
        """消息；时间窗看发起时刻。按会话、发起时刻、``prompt_id`` 排。"""

        found = await stats.prompts(app.id, _scope(body))
        return PromptStatsOut(
            items=tuple(
                PromptStatOut(
                    session_id=row.session_id,
                    prompt_id=row.prompt_id,
                    user_name=row.user_name,
                    created_at=row.created_at,
                )
                for row in found
            )
        )

    @router.post("/runs", response_model=RunStatsOut)
    async def runs(body: StatsQueryIn, app: CallingApp = caller) -> RunStatsOut:
        """跑到终态的顶层运行；时间窗看开始事件的时刻。按会话、开始时刻、``run_id`` 排。"""

        found = await stats.runs(app.id, _scope(body))
        return RunStatsOut(
            items=tuple(
                RunStatOut(
                    session_id=row.session_id,
                    run_id=row.run_id,
                    user_name=row.user_name,
                    started_at=row.started_at,
                    ended_at=row.ended_at,
                )
                for row in found
            )
        )

    @router.post("/usage", response_model=UsageStatsOut)
    async def usage(body: StatsQueryIn, app: CallingApp = caller) -> UsageStatsOut:
        """按（会话，模型）的累计用量；时间窗看最后一次累加的时刻。按会话、模型名排。"""

        found = await stats.usage(app.id, _scope(body))
        return UsageStatsOut(
            items=tuple(
                UsageStatOut(
                    session_id=row.session_id,
                    model_name=row.model_name,
                    requests=row.requests,
                    input_tokens=row.input_tokens,
                    cache_read_tokens=row.cache_read_tokens,
                    cache_write_tokens=row.cache_write_tokens,
                    output_tokens=row.output_tokens,
                    last_at=row.last_at,
                )
                for row in found
            )
        )

    @router.post("/sessions", response_model=SessionStatsOut)
    async def sessions(body: StatsSessionsIn, app: CallingApp = caller) -> SessionStatsOut:
        """这几段会话里跑过的：第一条消息的时刻、最近一条消息的 ``user_name``。按会话排。"""

        found = await stats.sessions(app.id, body.session_ids)
        return SessionStatsOut(
            items=tuple(
                SessionStatOut(
                    session_id=row.session_id,
                    first_prompt_at=row.first_prompt_at,
                    latest_user_name=row.latest_user_name,
                )
                for row in found
            )
        )

    return router


__all__ = ["create_stats_router"]
