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


@dataclass(frozen=True, slots=True)
class RuntimeFacts:
    prompts: Sequence[PromptStatOut] = ()
    runs: Sequence[RunStatOut] = ()
    usage: Sequence[UsageStatOut] = ()
    sessions: Sequence[SessionStatOut] = ()

    def params(self) -> dict[str, list[Any]]:
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
    merged: dict[str, RunStatOut] = {}
    for group in groups:
        for row in group:
            merged.setdefault(row.run_id, row)
    return tuple(merged.values())


__all__ = ["FACTS_CTE", "RuntimeFacts", "RuntimeStats", "WindowFacts", "merge_runs"]
