from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Collection, Hashable, Iterable, Sequence
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

PROMPT_FACTS: Final = """unnest(
        CAST(:f_prompt_sessions AS uuid[]), CAST(:f_prompt_users AS text[]),
        CAST(:f_prompt_times AS timestamptz[]))
    AS f(conversation_id, user_name, created_at)"""

RUN_FACTS: Final = """unnest(
        CAST(:f_run_sessions AS uuid[]), CAST(:f_run_users AS text[]),
        CAST(:f_run_started AS timestamptz[]), CAST(:f_run_ended AS timestamptz[]))
    AS f(conversation_id, user_name, started_at, ended_at)"""

USAGE_FACTS: Final = """unnest(
        CAST(:f_usage_sessions AS uuid[]), CAST(:f_usage_models AS text[]),
        CAST(:f_usage_requests AS bigint[]), CAST(:f_usage_input AS bigint[]),
        CAST(:f_usage_cache_read AS bigint[]), CAST(:f_usage_cache_write AS bigint[]),
        CAST(:f_usage_output AS bigint[]), CAST(:f_usage_last AS timestamptz[]))
    AS f(conversation_id, model_name, requests, input_tokens, cache_read_tokens,
         cache_write_tokens, output_tokens, last_at)"""

SESSION_FACTS: Final = """unnest(
        CAST(:f_session_ids AS uuid[]), CAST(:f_session_first AS timestamptz[]),
        CAST(:f_session_users AS text[]))
    AS f(conversation_id, first_prompt_at, latest_user_name)"""


@dataclass(frozen=True, slots=True)
class RuntimeFacts:
    prompts: Sequence[PromptStatOut]
    runs: Sequence[RunStatOut]
    usage: Sequence[UsageStatOut]
    sessions: Sequence[SessionStatOut]

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
        pages = await asyncio.gather(
            *(
                self._client.stats_sessions(StatsSessionsIn(session_ids=batch))
                for batch in _batches(ids)
            )
        )
        return [row for page in pages for row in page.items]

    async def facts(
        self,
        since: datetime,
        until: datetime | None,
        *,
        delivered: Collection[uuid.UUID],
        created: Collection[uuid.UUID],
    ) -> RuntimeFacts:
        prompts, created_prompts, runs, session_runs, usage, created_usage = await asyncio.gather(
            self.prompts_in(since, until),
            self.prompts_of(created),
            self.runs_in(since, until),
            self.runs_of({*delivered, *created}),
            self.usage_in(since, until),
            self.usage_of(created),
        )
        return RuntimeFacts(
            prompts=_merged(lambda row: row.prompt_id, prompts, created_prompts),
            runs=_merged(lambda row: row.run_id, runs, session_runs),
            usage=_merged(lambda row: (row.session_id, row.model_name), usage, created_usage),
            sessions=await self.sessions_of(
                {*delivered, *created, *(row.session_id for row in usage)}
            ),
        )


class _Page[T](Protocol):
    @property
    def items(self) -> tuple[T, ...]: ...


async def _by_sessions[T](
    ids: Collection[uuid.UUID], fetch: Callable[[StatsQueryIn], Awaitable[_Page[T]]]
) -> Sequence[T]:
    pages = await asyncio.gather(
        *(fetch(StatsQueryIn(session_ids=batch)) for batch in _batches(ids))
    )
    return [row for page in pages for row in page.items]


def _merged[T](key: Callable[[T], Hashable], *groups: Sequence[T]) -> tuple[T, ...]:
    merged: dict[Hashable, T] = {}
    for group in groups:
        for row in group:
            merged.setdefault(key(row), row)
    return tuple(merged.values())


__all__ = [
    "PROMPT_FACTS",
    "RUN_FACTS",
    "SESSION_FACTS",
    "USAGE_FACTS",
    "RuntimeFacts",
    "RuntimeStats",
]
