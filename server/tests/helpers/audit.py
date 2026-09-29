"""审计报表集成测试的种子：原生 SQL 直插，时间戳都由调用方给（业务仓储用数据库时钟，控不住时刻）。"""

from __future__ import annotations

import json
import uuid
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_GENERATE
from iclip.domains.tracking.models import VIDEO_DOWNLOADED


class Plant:
    """在一个事务连接上种用户、需求单、对话、运行、出片、下载与用量。"""

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn
        self._names: dict[uuid.UUID, str] = {}

    async def user(self, name: str) -> uuid.UUID:
        user_id = uuid.uuid4()
        await self._conn.execute(
            text(
                "INSERT INTO iclip.users (id, username, email, hashed_password, is_active,"
                " is_superuser, is_verified, display_name, avatar_url, roles,"
                " direct_permissions, city, job_title, departments)"
                " VALUES (:id, :name, :email, 'x', true, false, true, :name, '',"
                " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
            ),
            {"id": user_id, "name": name, "email": f"{name}@example.test"},
        )
        self._names[user_id] = name
        return user_id

    async def task(
        self, creator: uuid.UUID, *, at: datetime, title: str | None = None
    ) -> uuid.UUID:
        task_id = uuid.uuid4()
        await self._conn.execute(
            text(
                "INSERT INTO iclip.tasks (id, title, status, priority, creator_user_id, inputs,"
                " created_at, updated_at)"
                " VALUES (:id, :title, 'draft', 0, :creator, '{}'::jsonb, :at, :at)"
            ),
            {"id": task_id, "title": title or f"单 {task_id}", "creator": creator, "at": at},
        )
        return task_id

    async def conversation(
        self,
        owner: uuid.UUID,
        *,
        at: datetime,
        task_id: uuid.UUID | None = None,
        title: str | None = None,
        deleted_at: datetime | None = None,
        forked_from: uuid.UUID | None = None,
    ) -> uuid.UUID:
        conversation_id = uuid.uuid4()
        await self._conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, task_id,"
                " created_at, updated_at, deleted_at, forked_from, fork_turn)"
                " VALUES (:id, :owner, 'agent', :title, :task_id, :at, :at, :deleted_at,"
                " :forked_from, :fork_turn)"
            ),
            {
                "id": conversation_id,
                "owner": owner,
                "title": title or f"对话 {conversation_id}",
                "task_id": task_id,
                "at": at,
                "deleted_at": deleted_at,
                "forked_from": forked_from,
                "fork_turn": None if forked_from is None else 1,
            },
        )
        return conversation_id

    async def prompt(self, conversation_id: uuid.UUID, *, user_name: str, at: datetime) -> str:
        """一条消息：运行次数与活跃人数都数它，锚点是发起时刻。"""

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
        """这条消息的一次运行：登记 run_id，落开始事件，给了 ``ended_at`` 再落终态事件。"""

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

    async def turn(
        self,
        conversation_id: uuid.UUID,
        *,
        user_name: str,
        started_at: datetime,
        ended_at: datetime | None,
    ) -> None:
        """一条消息跑一轮，发起即开跑。"""

        prompt_id = await self.prompt(conversation_id, user_name=user_name, at=started_at)
        await self.run(prompt_id, started_at=started_at, ended_at=ended_at)

    async def video(
        self,
        conversation_id: uuid.UUID,
        *,
        owner: uuid.UUID,
        shot: int,
        created_at: datetime,
        finished_at: datetime | None = None,
        submitted_at: datetime | None = None,
        status: str = STATUS_COMPLETED,
        duration_ms: int | None = None,
    ) -> uuid.UUID:
        """一条出片：没有来源的视频 generate，带镜号。"""

        video_id = uuid.uuid4()
        await self._conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, shot_index, duration_ms, created_at,"
                " submitted_at, finished_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
                " CAST(:request AS jsonb), :status, :shot, :duration_ms, :created_at,"
                " :submitted_at, :finished_at)"
            ),
            {
                "id": video_id,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_GENERATE,
                "request": json.dumps(
                    {"model": "m", "prompt": "p", "user_name": self._names[owner]}
                ),
                "status": status,
                "shot": shot,
                "duration_ms": duration_ms,
                "created_at": created_at,
                "submitted_at": submitted_at,
                "finished_at": finished_at,
            },
        )
        return video_id

    async def download(self, job_id: uuid.UUID, *, user_id: uuid.UUID) -> None:
        await self._conn.execute(
            text(
                "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at)"
                " VALUES (:id, :name, :job_id, :user_id, now())"
            ),
            {"id": uuid.uuid4(), "name": VIDEO_DOWNLOADED, "job_id": job_id, "user_id": user_id},
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
        """一个模型上的累计用量，token 全记在普通输入上。"""

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
