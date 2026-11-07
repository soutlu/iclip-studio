from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


class Plant:
    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    async def prompt(self, conversation_id: uuid.UUID, *, user_name: str, at: datetime) -> str:
        prompt_id = f"prm_{uuid.uuid4().hex[:8]}"
        await self._conn.execute(
            text(
                "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id,"
                " owner_user_id, user_name, content, status, created_at, finished_at)"
                " VALUES (:prompt_id, :conversation_id, 'agent', :owner, :user_name, '',"
                " 'done', :at, :at)"
            ),
            {
                "prompt_id": prompt_id,
                "conversation_id": str(conversation_id),
                "owner": uuid.uuid4(),
                "user_name": user_name,
                "at": at,
            },
        )
        return prompt_id

    async def run(
        self,
        prompt_id: str,
        *,
        started_at: datetime,
        ended_at: datetime | None,
        end: str = "run_completed",
    ) -> None:
        run_id = f"agent-{uuid.uuid4().hex[:8]}"
        await self._conn.execute(
            text(
                "INSERT INTO agent_runtime.agent_job_runs (run_id, prompt_id, started_at)"
                " VALUES (:run_id, :prompt_id, :at)"
            ),
            {"run_id": run_id, "prompt_id": prompt_id, "at": started_at},
        )
        for kind, at in (("run_started", started_at), (end, ended_at)):
            if at is None:
                continue
            await self._conn.execute(
                text(
                    "INSERT INTO agent_runtime.events (run_id, kind, step_index, timestamp,"
                    " metadata) VALUES (:run_id, :kind, 0, :at, '{}')"
                ),
                {"run_id": run_id, "kind": kind, "at": at},
            )

    async def usage(
        self,
        conversation_id: uuid.UUID,
        *,
        tokens: int,
        last_at: datetime,
        model: str = "m-a",
        requests: int = 1,
    ) -> None:
        await self._conn.execute(
            text(
                "INSERT INTO agent_runtime.conversation_usage (conversation_id, model_name,"
                " requests, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,"
                " first_at, last_at)"
                " VALUES (:conversation_id, :model, :requests, :tokens, 0, 0, 0, :at, :at)"
            ),
            {
                "conversation_id": str(conversation_id),
                "model": model,
                "requests": requests,
                "tokens": tokens,
                "at": last_at,
            },
        )


__all__ = ["Plant"]
