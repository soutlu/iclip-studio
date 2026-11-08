from __future__ import annotations

import uuid

from iclip.platform.runtime_api.transcript.wire import Envelope, SessionActivityOut


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


__all__ = [
    "GatePayload",
    "RunStartedPayload",
    "TurnStartedPayload",
]
