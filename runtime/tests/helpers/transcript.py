from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel
from pydantic_ai_harness.step_persistence import (
    InMemoryStepStore,
    RunRecord,
    StepEvent,
    StepStore,
    ToolEffectRecord,
)

from cue.harness.job_status import JobStatus
from cue.harness.transcript.from_messages import SteeredPrompt
from cue.harness.transcript.history import TranscriptHistory
from cue.harness.transcript.service import TranscriptService
from cue.harness.transcript.store import OpBatch, TranscriptStore
from cue.harness.transcript.subscription import subscribe_frames
from cue.transcript.display import ToolDisplayRegistry
from cue.transcript.ops import MAIN_AGENT_ID
from cue.transcript.wire import OpsPayload, TranscriptPage
from tests.helpers.golden import CONTRACT_DIR, check_golden_file

GOLDEN_DIR = CONTRACT_DIR / "transcript"


class PerRunBatchReads:
    async def list_events_for_runs(
        self: StepStore, run_ids: Sequence[str]
    ) -> Mapping[str, list[StepEvent]]:
        return {run_id: await self.list_events(run_id=run_id) for run_id in run_ids}

    async def list_child_runs(
        self: StepStore, parent_run_ids: Sequence[str]
    ) -> Mapping[str, list[RunRecord]]:
        return {run_id: await self.list_runs(parent_run_id=run_id) for run_id in parent_run_ids}

    async def get_tool_effects(
        self: StepStore, keys: Sequence[tuple[str, str]]
    ) -> Mapping[tuple[str, str], ToolEffectRecord]:
        found: dict[tuple[str, str], ToolEffectRecord] = {}
        for run_id, tool_call_id in keys:
            effect = await self.get_tool_effect(run_id=run_id, tool_call_id=tool_call_id)
            if effect is not None:
                found[(run_id, tool_call_id)] = effect
        return found


class EmptyConversationSnapshots(PerRunBatchReads, InMemoryStepStore):
    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> None:
        return None


class NoPromptRuns:
    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]:
        return {}

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, JobStatus]:
        return {}

    async def steered_prompts(self, conversation_id: str) -> tuple[SteeredPrompt, ...]:
        return ()


_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SHORT_ID = re.compile(r"^(?:[a-z_]+-[0-9a-f]{8}|prm_[0-9a-f]{8,})$")


class Normalizer:
    def __init__(self) -> None:
        self._ids: dict[str, str] = {}

    def __call__(self, value: Any) -> Any:
        if isinstance(value, BaseModel):
            return self(value.model_dump(by_alias=True, exclude_none=True))
        if isinstance(value, dict):
            return {key: self._field(key, item) for key, item in value.items()}
        if isinstance(value, list | tuple):
            return [self(item) for item in value]
        if isinstance(value, str):
            return self._scalar(value)
        return value

    def _field(self, key: str, value: Any) -> Any:
        if key == "stream_epoch":
            return "<epoch>"
        if key == "durationMs":
            return 0
        return self(value)

    def _scalar(self, value: str) -> str:
        if _TIMESTAMP.match(value):
            return "<ts>"
        if _UUID.match(value) or _SHORT_ID.match(value):
            return self._ids.setdefault(value, f"<id-{len(self._ids) + 1}>")
        return value


def normalize(value: Any) -> Any:
    return Normalizer()(value)


def comparable(page: TranscriptPage) -> dict[str, Any]:
    data = page.model_dump(by_alias=True, exclude_none=True)
    data.pop("seq", None)
    data.pop("prompts", None)
    meta = data.get("meta", {})
    data["meta"] = {"activity": meta.get("activity")}
    for turn in data.get("items", ()):
        if turn.get("kind") == "turn" and turn.get("state") in {"failed", "cancelled"}:
            turn.pop("usage", None)
            for step in turn.get("steps", ()):
                step.pop("usage", None)
    return normalize(data)


def _service(
    store: TranscriptStore, history: TranscriptHistory, queue: Any, runner: Any
) -> TranscriptService:
    return TranscriptService(
        store=store,
        history=history,
        queue=queue,
        runner=runner,
    )


async def live_page(
    store: TranscriptStore,
    conversation_id: str,
    agent_id: str,
    *,
    queue: Any,
    runner: Any,
    display: ToolDisplayRegistry,
    runtime_agent_id: str,
) -> TranscriptPage:
    replayed = TranscriptStore()
    for replayed_agent in dict.fromkeys((MAIN_AGENT_ID, agent_id)):
        for batch in whole_journal(store, conversation_id, replayed_agent):
            replayed.append(conversation_id, replayed_agent, batch.ops)
    history = TranscriptHistory(EmptyConversationSnapshots(), NoPromptRuns(), display)
    return await _service(replayed, history, queue, runner).page(
        conversation_id, agent_id=agent_id, runtime_agent_id=runtime_agent_id
    )


async def cold_page(
    step_store: Any,
    conversation_id: str,
    agent_id: str,
    *,
    queue: Any,
    runner: Any,
    display: ToolDisplayRegistry,
    runtime_agent_id: str,
    delegate_tool: str | None,
) -> TranscriptPage:
    history = TranscriptHistory(step_store, queue, display, delegate_tool)
    return await _service(TranscriptStore(), history, queue, runner).page(
        conversation_id, agent_id=agent_id, runtime_agent_id=runtime_agent_id
    )


def whole_journal(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> tuple[OpBatch, ...]:
    epoch = store.subscribe_view(conversation_id, agent_id).epoch
    return store.subscribe_view(conversation_id, agent_id, since=0, epoch=epoch).batches


def ws_frames(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> list[Any]:
    view = store.subscribe_view(conversation_id, agent_id)
    frames: list[Any] = [
        {
            "type": "transcript.reset",
            "stream_epoch": view.epoch,
            "payload": frame.model_dump(by_alias=True, exclude_none=True),
        }
        for frame in subscribe_frames(view, agent_id=agent_id, since=None)
    ]
    for batch in whole_journal(store, conversation_id, agent_id):
        frames.append(
            {
                "type": "transcript.ops",
                "stream_epoch": batch.epoch,
                "payload": OpsPayload(agent_id=agent_id, ops=batch.ops, seq=batch.seq).model_dump(
                    by_alias=True, exclude_none=True
                ),
            }
        )
    return frames


def check_golden(name: str, sample: Any) -> None:
    check_golden_file(GOLDEN_DIR / f"{name}.json", sample)


def frames_of(page: TranscriptPage, turn_id: str, step_id: str) -> Sequence[Any]:
    for turn in page.items:
        if turn.turn_id != turn_id:
            continue
        for step in turn.steps:
            if step.step_id == step_id:
                return step.frames
    raise AssertionError(f"没有 {step_id}")


__all__ = [
    "GOLDEN_DIR",
    "EmptyConversationSnapshots",
    "NoPromptRuns",
    "Normalizer",
    "PerRunBatchReads",
    "check_golden",
    "cold_page",
    "comparable",
    "frames_of",
    "live_page",
    "normalize",
    "whole_journal",
    "ws_frames",
]
