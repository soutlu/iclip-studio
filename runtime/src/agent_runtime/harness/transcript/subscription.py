from __future__ import annotations

from dataclasses import dataclass

from agent_runtime.harness.transcript.store import SubscribeView
from agent_runtime.transcript.wire import OpsPayload, ResetPayload


@dataclass(frozen=True, slots=True)
class SubscribeFrames:
    stream_epoch: str
    frames: tuple[ResetPayload | OpsPayload, ...]


def subscribe_frames(
    view: SubscribeView, *, agent_id: str, since: int | None
) -> tuple[ResetPayload | OpsPayload, ...]:
    if since is not None and view.complete:
        return tuple(
            OpsPayload(agent_id=agent_id, ops=batch.ops, seq=batch.seq) for batch in view.batches
        )
    return (ResetPayload(agent_id=agent_id, snapshot=view.snapshot, seq=view.watermark),)


__all__ = ["SubscribeFrames", "subscribe_frames"]
