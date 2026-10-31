"""审计报表从运行时取的事实行：消息、跑到终态的顶层运行、按模型的累计用量、每段会话的首末消息。

运行时的表只经它的统计接口读（``/v1/stats/*``，只答本应用的会话），报表 SQL 把取回的行当作参数化的伪表
（``FACTS_CTE``）接着聚合。按会话取时一次最多 ``MAX_STATS_SESSIONS`` 段，多的分批取；答不上抛
``RuntimeUnavailable``，由全局错误处理答 503。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol

from agent_runtime.app_wire import (
    MAX_STATS_SESSIONS,
    PromptStatOut,
    RunStatOut,
    SessionStatOut,
    StatsQueryIn,
    StatsSessionsIn,
    UsageStatOut,
)
from agent_runtime.client import RuntimeClient

FACTS_CTE: Final = """
prompt_facts AS (
    SELECT * FROM unnest(CAST(:f_prompt_sessions AS uuid[]), CAST(:f_prompt_users AS text[]),
                         CAST(:f_prompt_times AS timestamptz[]))
        AS f(conversation_id, user_name, created_at)
),
run_facts AS (
    SELECT * FROM unnest(CAST(:f_run_sessions AS uuid[]), CAST(:f_run_users AS text[]),
                         CAST(:f_run_started AS timestamptz[]), CAST(:f_run_ended AS timestamptz[]))
        AS f(conversation_id, user_name, started_at, ended_at)
),
usage_facts AS (
    SELECT * FROM unnest(CAST(:f_usage_sessions AS uuid[]), CAST(:f_usage_models AS text[]),
                         CAST(:f_usage_requests AS bigint[]), CAST(:f_usage_input AS bigint[]),
                         CAST(:f_usage_cache_read AS bigint[]), CAST(:f_usage_cache_write AS bigint[]),
                         CAST(:f_usage_output AS bigint[]), CAST(:f_usage_last AS timestamptz[]))
        AS f(conversation_id, model_name, requests, input_tokens, cache_read_tokens,
             cache_write_tokens, output_tokens, last_at)
),
session_facts AS (
    SELECT * FROM unnest(CAST(:f_session_ids AS uuid[]), CAST(:f_session_first AS timestamptz[]),
                         CAST(:f_session_users AS text[]))
        AS f(conversation_id, first_prompt_at, latest_user_name)
)"""
"""四张伪表：``prompt_facts`` 对应消息队列，``run_facts`` 是跑到终态的顶层运行，``usage_facts`` 对应用量
台账，``session_facts`` 是每段跑过的会话的首条消息时刻与最近一条消息的 ``user_name``。会话列都是对话 id。"""


@dataclass(frozen=True, slots=True)
class RuntimeFacts:
    """一次报表查询用到的运行时事实行；没取的种类为空。"""

    prompts: Sequence[PromptStatOut] = ()
    runs: Sequence[RunStatOut] = ()
    usage: Sequence[UsageStatOut] = ()
    sessions: Sequence[SessionStatOut] = ()

    def params(self) -> dict[str, list[Any]]:
        """``FACTS_CTE`` 的绑定参数：每列一个数组。"""

        return {
            "f_prompt_sessions": [row.session_id for row in self.prompts],
            "f_prompt_users": [row.user_name for row in self.prompts],
            "f_prompt_times": [row.created_at for row in self.prompts],
            "f_run_sessions": [row.session_id for row in self.runs],
            "f_run_users": [row.user_name for row in self.runs],
            "f_run_started": [row.started_at for row in self.runs],
            "f_run_ended": [row.ended_at for row in self.runs],
            "f_usage_sessions": [row.session_id for row in self.usage],
            "f_usage_models": [row.model_name for row in self.usage],
            "f_usage_requests": [row.requests for row in self.usage],
            "f_usage_input": [row.input_tokens for row in self.usage],
            "f_usage_cache_read": [row.cache_read_tokens for row in self.usage],
            "f_usage_cache_write": [row.cache_write_tokens for row in self.usage],
            "f_usage_output": [row.output_tokens for row in self.usage],
            "f_usage_last": [row.last_at for row in self.usage],
            "f_session_ids": [row.session_id for row in self.sessions],
            "f_session_first": [row.first_prompt_at for row in self.sessions],
            "f_session_users": [row.latest_user_name for row in self.sessions],
        }


@dataclass(frozen=True, slots=True)
class WindowFacts:
    """一段时间窗 ``[since, until)`` 一次取齐的事实行，落在窗里的筛选范围都从这份里切，不再向运行时取。

    ``prompts`` / ``runs`` / ``usage`` 是按这段窗取的（看各行自己的时刻）；``cycles`` 是交付周期样本
    （最后一条出片在窗里的对话）连同最后一条出片的完成时刻，``cycle_runs`` 是它们的全部运行；
    ``sessions`` 是向运行时要过首末消息的 ``session_ids`` 里跑过的那些。``until`` 为空不设上界。"""

    since: datetime
    until: datetime | None
    prompts: Sequence[PromptStatOut]
    runs: Sequence[RunStatOut]
    usage: Sequence[UsageStatOut]
    cycles: Mapping[uuid.UUID, datetime]
    cycle_runs: Sequence[RunStatOut]
    session_ids: frozenset[uuid.UUID]
    sessions: Sequence[SessionStatOut]

    def covers(self, since: datetime, until: datetime | None) -> bool:
        return self.since <= since and (
            self.until is None or (until is not None and until <= self.until)
        )

    def within(self, since: datetime, until: datetime | None) -> RuntimeFacts:
        """落在本窗里的 ``[since, until)`` 要的事实行，与直接按这段窗向运行时取的一致：窗内的消息、运行
        与用量，最后一条出片在窗内的对话的全部运行，它们与窗内有用量的对话的首末消息。"""

        def inside(moment: datetime) -> bool:
            return moment >= since and (until is None or moment < until)

        cycles = {conversation for conversation, at in self.cycles.items() if inside(at)}
        usage = [row for row in self.usage if inside(row.last_at)]
        wanted = {*cycles, *(row.session_id for row in usage)}
        return RuntimeFacts(
            prompts=[row for row in self.prompts if inside(row.created_at)],
            runs=merge_runs(
                [row for row in self.runs if inside(row.started_at)],
                [row for row in self.cycle_runs if row.session_id in cycles],
            ),
            usage=usage,
            sessions=[row for row in self.sessions if row.session_id in wanted],
        )


def _batches(ids: Collection[uuid.UUID]) -> Iterable[tuple[uuid.UUID, ...]]:
    ordered = sorted(set(ids))
    for start in range(0, len(ordered), MAX_STATS_SESSIONS):
        yield tuple(ordered[start : start + MAX_STATS_SESSIONS])


class RuntimeStats:
    """经运行时的统计接口取事实行。按时间窗取的 ``*_in`` 看各行自己的时刻，按会话取的 ``*_of`` 取全部行。"""

    def __init__(self, client: RuntimeClient) -> None:
        self._client = client

    async def prompts_in(self, since: datetime, until: datetime | None) -> Sequence[PromptStatOut]:
        found = await self._client.stats_prompts(StatsQueryIn(since=since, until=until))
        return found.items

    async def runs_in(self, since: datetime, until: datetime | None) -> Sequence[RunStatOut]:
        found = await self._client.stats_runs(StatsQueryIn(since=since, until=until))
        return found.items

    async def usage_in(self, since: datetime, until: datetime | None) -> Sequence[UsageStatOut]:
        found = await self._client.stats_usage(StatsQueryIn(since=since, until=until))
        return found.items

    async def prompts_of(self, ids: Collection[uuid.UUID]) -> Sequence[PromptStatOut]:
        return await _by_sessions(ids, self._client.stats_prompts)

    async def runs_of(self, ids: Collection[uuid.UUID]) -> Sequence[RunStatOut]:
        return await _by_sessions(ids, self._client.stats_runs)

    async def usage_of(self, ids: Collection[uuid.UUID]) -> Sequence[UsageStatOut]:
        return await _by_sessions(ids, self._client.stats_usage)

    async def sessions_of(self, ids: Collection[uuid.UUID]) -> Sequence[SessionStatOut]:
        found: list[SessionStatOut] = []
        for batch in _batches(ids):
            page = await self._client.stats_sessions(StatsSessionsIn(session_ids=batch))
            found.extend(page.items)
        return found


class _Page[T](Protocol):
    @property
    def items(self) -> tuple[T, ...]: ...


async def _by_sessions[T](
    ids: Collection[uuid.UUID], fetch: Callable[[StatsQueryIn], Awaitable[_Page[T]]]
) -> Sequence[T]:
    found: list[T] = []
    for batch in _batches(ids):
        page = await fetch(StatsQueryIn(session_ids=batch))
        found.extend(page.items)
    return found


def merge_runs(*groups: Sequence[RunStatOut]) -> tuple[RunStatOut, ...]:
    """把几次取回的运行并成一份，同一 ``run_id`` 只留一条。"""

    merged: dict[str, RunStatOut] = {}
    for group in groups:
        for row in group:
            merged.setdefault(row.run_id, row)
    return tuple(merged.values())


__all__ = ["FACTS_CTE", "RuntimeFacts", "RuntimeStats", "WindowFacts", "merge_runs"]
