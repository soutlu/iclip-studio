from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.audit.models import Scope
from iclip.domains.audit.reports_pg import PgAuditReports, audit_connection
from iclip.domains.audit.schemas import ExecutionOut
from iclip.domains.audit.service import AuditService
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED, STATUS_SUBMITTED
from iclip.domains.generation.schemas import (
    KIND_AUDIO,
    KIND_IMAGE,
    KIND_SUBTITLE,
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_ENHANCE,
    OPERATION_GENERATE,
    OPERATION_RENDER,
    OPERATION_UPLOAD,
)
from iclip.domains.tracking.models import VIDEO_DOWNLOADED
from iclip.platform.db.engine import build_engine
from tests.helpers.audit import EVER, open_session

BASE = datetime.now(UTC).replace(microsecond=0)
SARA = "Sara.Hong"
DEREK = "Derek.Lam"
EVA = "Eva.Lin"


def ago(**delta: float) -> datetime:
    return BASE - timedelta(**delta)


class Seed:
    def __init__(self) -> None:
        self.sara = uuid.uuid4()
        self.derek = uuid.uuid4()
        self.task = uuid.uuid4()
        self.stuck_task = uuid.uuid4()
        self.c1 = uuid.uuid4()
        self.c2 = uuid.uuid4()
        self.c3 = uuid.uuid4()
        self.c4 = uuid.uuid4()
        self.c5 = uuid.uuid4()
        self.c1_agent_job_at = ago(hours=2)
        self.c2_created_at = ago(hours=5)
        self.missing_shot_video = uuid.uuid4()
        self.stuck_video = uuid.uuid4()
        self.c1_shot1_video = uuid.uuid4()
        self.c1_shot2_video = uuid.uuid4()
        self.c1_shot2_master = uuid.uuid4()

    async def plant(self, engine: AsyncEngine) -> None:
        async with engine.begin() as conn:
            for user_id, name in ((self.sara, SARA), (self.derek, DEREK)):
                await conn.execute(
                    text(
                        "INSERT INTO iclip.users (id, username, email, hashed_password, is_active,"
                        " is_superuser, is_verified, display_name, avatar_url, roles,"
                        " direct_permissions, city, job_title, departments)"
                        " VALUES (:id, :name, :email, 'x', true, false, true, :name, '',"
                        " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
                    ),
                    {"id": user_id, "name": name, "email": f"{name}@example.test"},
                )
            for task_id, title in ((self.task, "夏季连衣裙"), (self.stuck_task, "卡住的单")):
                await conn.execute(
                    text(
                        "INSERT INTO iclip.tasks (id, title, status, priority, creator_user_id,"
                        " inputs, created_at, updated_at)"
                        " VALUES (:id, :title, 'draft', 0, :creator, '{}'::jsonb, :at, :at)"
                    ),
                    {"id": task_id, "title": title, "creator": self.sara, "at": ago(days=3)},
                )

            async def conversation(
                conversation_id: uuid.UUID,
                *,
                owner: uuid.UUID,
                task_id: uuid.UUID | None,
                created_at: datetime,
                updated_at: datetime,
                deleted_at: datetime | None = None,
            ) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title,"
                        " task_id, created_at, updated_at, deleted_at)"
                        " VALUES (:id, :owner, 'agent', :title, :task_id, :created_at,"
                        " :updated_at, :deleted_at)"
                    ),
                    {
                        "id": conversation_id,
                        "owner": owner,
                        "title": f"对话 {conversation_id}",
                        "task_id": task_id,
                        "created_at": created_at,
                        "updated_at": updated_at,
                        "deleted_at": deleted_at,
                    },
                )
                await open_session(conn, conversation_id)

            async def agent_job(
                conversation_id: uuid.UUID, *, user_name: str, at: datetime
            ) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id,"
                        " owner_user_id, user_name, content, status, created_at, finished_at)"
                        " VALUES (:prompt_id, :conversation_id, 'agent', :owner, :user_name, '',"
                        " 'done', :at, :at)"
                    ),
                    {
                        "prompt_id": str(uuid.uuid4()),
                        "conversation_id": str(conversation_id),
                        "owner": self.sara,
                        "user_name": user_name,
                        "at": at,
                    },
                )

            names = {self.sara: SARA, self.derek: DEREK}

            async def video(
                conversation_id: uuid.UUID,
                *,
                owner: uuid.UUID,
                label: str | None = None,
                shot: int | None,
                status: str,
                created_at: datetime,
                submitted_at: datetime | None = None,
                finished_at: datetime | None = None,
                video_id: uuid.UUID | None = None,
                edit_of: uuid.UUID | None = None,
                metadata: dict[str, object] | None = None,
            ) -> uuid.UUID:
                job_id = video_id or uuid.uuid4()
                await conn.execute(
                    text(
                        "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                        " kind, operation, provider, request, status, shot_index, metadata,"
                        " source_job_id, root_job_id, created_at,"
                        " submitted_at, finished_at)"
                        " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
                        " CAST(:request AS jsonb), :status, :shot, CAST(:metadata AS jsonb),"
                        " :edit_of, :edit_of, :created_at,"
                        " :submitted_at, :finished_at)"
                    ),
                    {
                        "id": job_id,
                        "kind": KIND_VIDEO,
                        "operation": OPERATION_GENERATE,
                        "owner": owner,
                        "conversation_id": conversation_id,
                        "request": json.dumps(
                            {"model": "m", "prompt": "p", "user_name": label or names[owner]}
                            | (
                                {}
                                if edit_of is None
                                else {"range_start_ms": 1000, "range_end_ms": 4000}
                            )
                        ),
                        "status": status,
                        "shot": shot,
                        "metadata": None if metadata is None else json.dumps(metadata),
                        "edit_of": edit_of,
                        "created_at": created_at,
                        "submitted_at": submitted_at,
                        "finished_at": finished_at,
                    },
                )
                return job_id

            async def master(
                master_id: uuid.UUID,
                conversation_id: uuid.UUID,
                *,
                root: uuid.UUID,
                shot: int,
                created_at: datetime,
            ) -> None:
                edit = await video(
                    conversation_id,
                    owner=self.sara,
                    shot=shot,
                    status=STATUS_COMPLETED,
                    created_at=created_at - timedelta(minutes=1),
                    finished_at=created_at - timedelta(seconds=30),
                    edit_of=root,
                )
                await conn.execute(
                    text(
                        "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                        " kind, operation, provider, request, status, shot_index, source_job_id,"
                        " root_job_id, output, created_at, submitted_at, finished_at)"
                        " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
                        " CAST(:request AS jsonb), :status, :shot, :root, :root,"
                        " jsonb_build_object('url', 'https://example.test/master.mp4'),"
                        " :at, :at, :at)"
                    ),
                    {
                        "id": master_id,
                        "owner": self.sara,
                        "conversation_id": conversation_id,
                        "kind": KIND_VIDEO,
                        "operation": OPERATION_COMPOSE,
                        "request": json.dumps(
                            {
                                "segments": [
                                    {
                                        "sourceJobId": str(edit),
                                        "url": "https://example.test/e.mp4",
                                        "start": 0,
                                        "end": 3,
                                    }
                                ]
                            }
                        ),
                        "status": STATUS_COMPLETED,
                        "shot": shot,
                        "root": root,
                        "at": created_at,
                    },
                )

            async def download(job_id: uuid.UUID, *, user_id: uuid.UUID) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at)"
                        " VALUES (:id, :name, :job_id, :user_id, now())"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "name": VIDEO_DOWNLOADED,
                        "job_id": job_id,
                        "user_id": user_id,
                    },
                )

            async def usage(
                conversation_id: uuid.UUID,
                model: str,
                *,
                requests: int,
                input_tokens: int,
                cache_read: int,
                cache_write: int,
                output: int,
                last_at: datetime,
            ) -> None:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.conversation_usage (conversation_id, model_name,"
                        " requests, input_tokens, cache_read_tokens, cache_write_tokens,"
                        " output_tokens, first_at, last_at)"
                        " VALUES (:conversation_id, :model, :requests, :input_tokens, :cache_read,"
                        " :cache_write, :output, :last_at, :last_at)"
                    ),
                    {
                        "conversation_id": str(conversation_id),
                        "model": model,
                        "requests": requests,
                        "input_tokens": input_tokens,
                        "cache_read": cache_read,
                        "cache_write": cache_write,
                        "output": output,
                        "last_at": last_at,
                    },
                )

            await conversation(
                self.c1,
                owner=self.sara,
                task_id=self.task,
                created_at=ago(hours=3),
                updated_at=ago(minutes=40),
            )
            await agent_job(self.c1, user_name=SARA, at=self.c1_agent_job_at)
            await video(
                self.c1,
                owner=self.sara,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=100),
                submitted_at=ago(minutes=99),
                finished_at=ago(minutes=90),
                video_id=self.c1_shot1_video,
            )
            await video(
                self.c1,
                owner=self.sara,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=95),
                submitted_at=ago(minutes=94),
                finished_at=ago(minutes=85),
            )
            await video(
                self.c1,
                owner=self.sara,
                shot=2,
                status=STATUS_FAILED,
                created_at=ago(minutes=80),
                finished_at=ago(minutes=75),
            )
            await video(
                self.c1,
                owner=self.sara,
                shot=2,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=70),
                submitted_at=ago(minutes=69),
                finished_at=ago(minutes=60),
                video_id=self.c1_shot2_video,
            )
            await video(
                self.c1,
                owner=self.sara,
                shot=2,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=50),
                submitted_at=ago(minutes=49),
                finished_at=ago(minutes=40),
            )
            await video(
                self.c1,
                owner=self.sara,
                shot=None,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=10),
                finished_at=ago(minutes=5),
                video_id=self.missing_shot_video,
                metadata={"shot": 1},
            )
            await video(
                self.c1,
                owner=self.sara,
                shot=None,
                status=STATUS_COMPLETED,
                created_at=ago(minutes=8),
                finished_at=ago(minutes=4),
                edit_of=self.missing_shot_video,
            )
            await master(
                self.c1_shot2_master,
                self.c1,
                root=self.c1_shot2_video,
                shot=2,
                created_at=ago(minutes=30),
            )
            await download(self.c1_shot1_video, user_id=self.sara)
            await download(self.c1_shot1_video, user_id=self.derek)
            await download(self.c1_shot2_master, user_id=self.sara)
            await usage(
                self.c1,
                "m-a",
                requests=4,
                input_tokens=1000,
                cache_read=500,
                cache_write=100,
                output=200,
                last_at=ago(minutes=45),
            )
            await usage(
                self.c1,
                "m-b",
                requests=1,
                input_tokens=100,
                cache_read=0,
                cache_write=0,
                output=50,
                last_at=ago(minutes=44),
            )

            await conversation(
                self.c2,
                owner=self.derek,
                task_id=self.task,
                created_at=self.c2_created_at,
                updated_at=ago(hours=3),
            )
            await video(
                self.c2,
                owner=self.derek,
                label=SARA,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(hours=4),
                submitted_at=ago(hours=4) + timedelta(minutes=1),
                finished_at=ago(hours=3),
            )
            await video(
                self.c2,
                owner=self.derek,
                label=SARA,
                shot=2,
                status=STATUS_SUBMITTED,
                created_at=ago(hours=3),
                submitted_at=ago(hours=3),
                video_id=self.stuck_video,
            )

            await conversation(
                self.c3,
                owner=self.sara,
                task_id=None,
                created_at=ago(hours=30),
                updated_at=ago(hours=28),
            )
            await agent_job(self.c3, user_name=SARA, at=ago(hours=29))
            await video(
                self.c3,
                owner=self.sara,
                shot=1,
                status=STATUS_COMPLETED,
                created_at=ago(hours=29),
                submitted_at=ago(hours=29) + timedelta(minutes=1),
                finished_at=ago(hours=28),
            )
            await usage(
                self.c3,
                "m-a",
                requests=2,
                input_tokens=300,
                cache_read=100,
                cache_write=0,
                output=60,
                last_at=ago(hours=28),
            )

            await conversation(
                self.c4,
                owner=self.derek,
                task_id=self.task,
                created_at=ago(hours=49),
                updated_at=ago(hours=48),
            )
            await agent_job(self.c4, user_name=DEREK, at=ago(hours=49))

            await conversation(
                self.c5,
                owner=self.sara,
                task_id=None,
                created_at=ago(hours=2),
                updated_at=ago(hours=1),
                deleted_at=ago(hours=1),
            )
            await agent_job(self.c5, user_name=EVA, at=ago(minutes=90))

            for _ in range(3):
                await conversation(
                    uuid.uuid4(),
                    owner=self.derek,
                    task_id=self.stuck_task,
                    created_at=ago(hours=6),
                    updated_at=ago(hours=6),
                )


@pytest.fixture
async def seed(engine: AsyncEngine) -> Seed:
    planted = Seed()
    await planted.plant(engine)
    return planted


async def executions_by_id(service: AuditService) -> dict[uuid.UUID, ExecutionOut]:
    page = await service.executions(since=ago(days=3), limit=100)
    return {item.conversation_id: item for item in page.items}


async def test_overall_counts_every_metric_on_its_own_anchor(
    reports: PgAuditReports, seed: Seed
) -> None:
    overall = await reports.overall(Scope(since=EVER))

    assert overall.completed_videos == 6
    assert (overall.delivered_tasks, overall.delivered_orphan_conversations) == (1, 1)
    assert overall.deliveries == 2
    assert overall.producers == 2
    assert (overall.shots, overall.attempts, overall.one_take_shots) == (4, 6, 2)
    assert overall.attempts_per_shot == 1.5
    assert overall.one_take_rate == 0.5
    assert overall.runs == 4
    assert overall.delivered_conversations == 3
    assert overall.cycle_seconds is not None
    assert (overall.cycle_seconds.avg, overall.cycle_seconds.median) == (5200, 4800)
    assert overall.cycle_seconds.p90 == pytest.approx(6720)
    assert overall.upstream_seconds is not None
    assert overall.upstream_seconds.avg == 1540
    assert (
        overall.usage.requests,
        overall.usage.input_tokens,
        overall.usage.cache_read_tokens,
        overall.usage.cache_write_tokens,
        overall.usage.output_tokens,
    ) == (7, 1400, 600, 100, 310)
    assert overall.usage.cache_hit_rate == pytest.approx(600 / 2100)
    assert overall.tokens_per_delivery == 2410 / 2


async def test_window_applies_to_each_metric_anchor(reports: PgAuditReports, seed: Seed) -> None:
    recent = await reports.overall(Scope(since=ago(hours=2)))

    assert recent.completed_videos == 4
    assert (recent.delivered_tasks, recent.delivered_orphan_conversations) == (1, 0)
    assert (recent.shots, recent.attempts, recent.one_take_shots) == (2, 4, 0)
    assert recent.runs == 2
    assert recent.delivered_conversations == 1
    assert recent.cycle_seconds is not None and recent.cycle_seconds.avg == 4800
    assert recent.usage.requests == 5


async def test_empty_scope_is_all_zeros(reports: PgAuditReports, seed: Seed) -> None:
    nothing = await reports.overall(Scope(since=EVER, user_name="Nobody"))

    assert nothing.completed_videos == 0
    assert nothing.deliveries == 0
    assert nothing.cycle_seconds is None
    assert nothing.usage.requests == 0


async def test_attempt_distribution_buckets_shots_by_their_attempt_count(
    reports: PgAuditReports, seed: Seed
) -> None:
    everything = await reports.attempt_distribution(Scope(since=EVER))
    recent = await reports.attempt_distribution(Scope(since=ago(hours=2)))
    by_derek = await reports.attempt_distribution(Scope(since=EVER, user_name=DEREK))
    nobody = await reports.attempt_distribution(Scope(since=EVER, user_name="Nobody"))

    assert [(row.attempts, row.shots) for row in everything] == [(1, 2), (2, 2)]
    assert [(row.attempts, row.shots) for row in recent] == [(2, 2)]
    assert [(row.attempts, row.shots) for row in by_derek] == [(1, 1)]
    assert nobody == []


async def test_by_user_attributes_videos_by_owner_and_conversations_by_latest_run(
    reports: PgAuditReports, seed: Seed
) -> None:
    rows = await reports.by_user(Scope(since=EVER))

    assert set(rows) == {SARA, DEREK, EVA}
    sara, derek, eva = rows[SARA], rows[DEREK], rows[EVA]
    assert (sara.completed_videos, sara.deliveries) == (5, 2)
    assert (sara.shots, sara.attempts, sara.one_take_shots) == (3, 5, 1)
    assert sara.runs == 2
    assert sara.delivered_conversations == 2
    assert sara.usage.requests == 7
    assert (derek.completed_videos, derek.deliveries) == (1, 1)
    assert (derek.shots, derek.attempts, derek.one_take_shots) == (1, 1, 1)
    assert derek.runs == 1
    assert derek.delivered_conversations == 1
    assert derek.cycle_seconds is not None and derek.cycle_seconds.avg == 7200
    assert derek.usage.requests == 0
    assert (eva.runs, eva.deliveries, eva.shots, eva.usage.requests) == (1, 0, 0, 0)
    assert eva.cycle_seconds is None


async def test_by_period_buckets_in_the_given_timezone(reports: PgAuditReports, seed: Seed) -> None:
    singapore = ZoneInfo("Asia/Singapore")

    rows = await reports.by_period(
        Scope(since=ago(days=3)), bucket="day", timezone="Asia/Singapore"
    )

    assert rows and all(row.period_start.astimezone(singapore).hour == 0 for row in rows)
    assert [row.period_start for row in rows] == sorted(row.period_start for row in rows)
    assert sum(row.metrics.completed_videos for row in rows) == 6
    assert sum(row.metrics.shots for row in rows) == 4
    assert sum(row.metrics.runs for row in rows) == 4
    assert sum(row.metrics.delivered_conversations for row in rows) == 3
    assert sum(row.metrics.usage.requests for row in rows) == 7


async def test_by_period_fills_every_bucket_of_a_bounded_window(
    reports: PgAuditReports, seed: Seed
) -> None:
    singapore = ZoneInfo("Asia/Singapore")
    since = ago(days=3)

    rows = await reports.by_period(Scope(since=since), bucket="day", timezone="Asia/Singapore")

    starts = [row.period_start.astimezone(singapore) for row in rows]
    assert len(starts) == 4
    assert starts[0].date() == since.astimezone(singapore).date()
    assert all(later - earlier == timedelta(days=1) for earlier, later in pairwise(starts))
    assert sum(row.metrics.completed_videos for row in rows) == 6
    assert sum(row.metrics.runs for row in rows) == 4
    quiet = [row.metrics for row in rows if row.metrics.completed_videos == 0]
    assert all(m.cycle_seconds is None and m.upstream_seconds is None for m in quiet)


async def test_executions_carry_whole_conversation_detail(
    service: AuditService, seed: Seed
) -> None:
    rows = await executions_by_id(service)

    assert set(rows) == {seed.c1, seed.c2, seed.c3, seed.c4, seed.c5}
    c1, c2, c3 = rows[seed.c1], rows[seed.c2], rows[seed.c3]
    assert (c1.user_name, c1.task_id, c1.task_title) == (SARA, seed.task, "夏季连衣裙")
    assert (c1.created_at, c1.started_at) == (ago(hours=3), seed.c1_agent_job_at)
    assert (c1.delivered_at, c1.deleted_at) == (ago(minutes=40), None)
    assert (c1.metrics.completed_videos, c1.metrics.runs) == (4, 1)
    assert c1.metrics.cycle_seconds is not None and c1.metrics.cycle_seconds.avg == 4800
    assert [(shot.shot, shot.attempts, shot.one_take) for shot in c1.shots] == [
        (1, 2, False),
        (2, 2, False),
    ]
    assert [(item.model_name, item.usage.requests) for item in c1.usage] == [("m-a", 4), ("m-b", 1)]
    assert (c2.user_name, c2.started_at, c2.task_title) == (
        DEREK,
        seed.c2_created_at,
        "夏季连衣裙",
    )
    assert [(shot.shot, shot.attempts, shot.one_take) for shot in c2.shots] == [(1, 1, True)]
    assert c2.usage == []
    assert (c3.task_id, c3.task_title) == (None, None)
    assert c3.metrics.delivered_orphan_conversations == 1
    c4, c5 = rows[seed.c4], rows[seed.c5]
    assert (c4.delivered_at, c4.shots, c4.metrics.runs) == (None, [], 1)
    assert c5.deleted_at == ago(hours=1) and c5.user_name == EVA


async def test_executions_window_falls_on_creation_and_user_filters_rows(
    service: AuditService, seed: Seed
) -> None:
    recent = await service.executions(since=ago(hours=4), limit=10)
    by_derek = await service.executions(since=ago(days=3), user_name=DEREK, limit=10)

    assert [row.conversation_id for row in recent.items] == [seed.c5, seed.c1]
    assert recent.total == 2
    assert {row.conversation_id for row in by_derek.items} == {seed.c2, seed.c4}


async def test_effective_shots_are_downloaded_shots(
    reports: PgAuditReports, service: AuditService, seed: Seed
) -> None:
    overall = await reports.overall(Scope(since=EVER))
    assert (overall.shots, overall.effective_shots) == (4, 2)
    assert overall.effective_rate == 0.5

    recent = await reports.overall(Scope(since=ago(hours=2)))
    assert (recent.shots, recent.effective_shots) == (2, 2)
    assert recent.effective_rate == 1

    by_user = await reports.by_user(Scope(since=EVER))
    assert (by_user[SARA].shots, by_user[SARA].effective_shots) == (3, 2)
    derek = by_user[DEREK]
    assert (derek.shots, derek.effective_shots) == (1, 0)
    assert derek.effective_rate == 0
    assert by_user[EVA].shots == 0 and by_user[EVA].effective_rate is None

    series = await reports.by_period(
        Scope(since=ago(days=3)), bucket="day", timezone="Asia/Singapore"
    )
    assert sum(row.metrics.shots for row in series) == 4
    assert sum(row.metrics.effective_shots for row in series) == 2
    quiet = [row.metrics for row in series if row.metrics.shots == 0]
    assert quiet and all(m.effective_shots == 0 and m.effective_rate is None for m in quiet)

    rows = await executions_by_id(service)
    assert [(shot.shot, shot.effective) for shot in rows[seed.c1].shots] == [(1, True), (2, True)]
    assert [(shot.shot, shot.effective) for shot in rows[seed.c2].shots] == [(1, False)]
    assert rows[seed.c1].metrics.effective_rate == 1
    assert rows[seed.c2].metrics.effective_rate == 0


async def test_forks_do_not_count_toward_any_metric(
    reports: PgAuditReports, service: AuditService, seed: Seed, engine: AsyncEngine
) -> None:
    before = await reports.overall(Scope(since=EVER))
    before_executions = await executions_by_id(service)
    fork_id, fork_video = uuid.uuid4(), uuid.uuid4()
    at = ago(hours=1)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, task_id,"
                " created_at, updated_at, forked_from, fork_turn)"
                " VALUES (:id, :owner, 'agent', '副本', :task_id, :at, :at, :source, 1)"
            ),
            {"id": fork_id, "owner": seed.sara, "task_id": seed.task, "at": at, "source": seed.c1},
        )
        await open_session(conn, fork_id)
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, shot_index,"
                " kind, operation, provider, request, status, output, created_at,"
                " submitted_at, finished_at)"
                " VALUES (:id, :owner, :conversation_id, 1, :kind, :operation, 'p',"
                " :request, :status, jsonb_build_object('url', 'https://example.test/copy.mp4'),"
                " :at, :at, :at)"
            ),
            {
                "id": fork_video,
                "owner": seed.sara,
                "conversation_id": fork_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_GENERATE,
                "status": STATUS_COMPLETED,
                "request": json.dumps({"kind": "video", "user_name": SARA}),
                "at": at,
            },
        )
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id,"
                " owner_user_id, user_name, content, status, created_at, finished_at)"
                " VALUES (:prompt_id, :conversation_id, 'agent', :owner, :user_name, '',"
                " 'done', :at, :at)"
            ),
            {
                "prompt_id": str(uuid.uuid4()),
                "conversation_id": str(fork_id),
                "owner": seed.sara,
                "user_name": SARA,
                "at": at,
            },
        )
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.conversation_usage (conversation_id, model_name,"
                " requests, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,"
                " first_at, last_at)"
                " VALUES (:conversation_id, 'test-model', 9, 900, 90, 9, 90, :at, :at)"
            ),
            {"conversation_id": str(fork_id), "at": at},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at)"
                " VALUES (:id, :name, :job_id, :user_id, now())"
            ),
            {
                "id": uuid.uuid4(),
                "name": VIDEO_DOWNLOADED,
                "job_id": fork_video,
                "user_id": seed.sara,
            },
        )

    after = await reports.overall(Scope(since=EVER))
    assert after == before
    assert await executions_by_id(service) == before_executions


async def test_videos_of_an_owner_without_username_count_overall_only(
    reports: PgAuditReports, service: AuditService, seed: Seed, engine: AsyncEngine
) -> None:
    before = await reports.overall(Scope(since=EVER))
    before_users = set(await reports.by_user(Scope(since=EVER)))
    bare, conversation_id, unmarked = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    at = ago(hours=1)
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser,"
                " is_verified, display_name, avatar_url, roles, direct_permissions, city,"
                " job_title, departments)"
                " VALUES (:id, :email, 'x', true, false, true, '撞名的人', '',"
                " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
            ),
            {"id": bare, "email": f"{bare}@example.test"},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
                " updated_at) VALUES (:id, :owner, 'agent', '没有用户名', :at, :at)"
            ),
            {"id": conversation_id, "owner": bare, "at": at},
        )
        await open_session(conn, conversation_id)
        for video_id, shot in ((uuid.uuid4(), 1), (unmarked, None)):
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                    " shot_index, kind, operation, provider, request, status, output,"
                    " created_at, submitted_at, finished_at)"
                    " VALUES (:id, :owner, :conversation_id, :shot, :kind, :operation, 'p',"
                    " :request, :status, jsonb_build_object('url', 'https://example.test/bare.mp4'),"
                    " :at, :at, :at)"
                ),
                {
                    "id": video_id,
                    "owner": bare,
                    "conversation_id": conversation_id,
                    "shot": shot,
                    "kind": KIND_VIDEO,
                    "operation": OPERATION_GENERATE,
                    "status": STATUS_COMPLETED,
                    "request": json.dumps({"model": "m", "prompt": "p", "user_name": "Ghost"}),
                    "at": at,
                },
            )

    after = await reports.overall(Scope(since=EVER))
    rows = await reports.by_user(Scope(since=EVER))
    executions = await executions_by_id(service)

    assert after.completed_videos == before.completed_videos + 1
    assert after.producers == before.producers
    assert set(rows) == before_users
    assert executions[conversation_id].user_name is None
    assert [(shot.shot, shot.attempts) for shot in executions[conversation_id].shots] == [(1, 1)]


async def test_uploads_and_cuts_do_not_count_toward_any_metric(
    reports: PgAuditReports, service: AuditService, seed: Seed, engine: AsyncEngine
) -> None:
    before = await reports.overall(Scope(since=EVER))
    before_users = await reports.by_user(Scope(since=EVER))
    before_executions = await executions_by_id(service)
    grid, cell, upload = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    at = ago(hours=1)
    async with engine.begin() as conn:
        for job_id, conversation_id, kind, operation, request, source in (
            (upload, None, KIND_VIDEO, OPERATION_UPLOAD, None, None),
            (grid, seed.c1, KIND_IMAGE, OPERATION_GENERATE, '{"prompt": "p"}', None),
            (cell, seed.c1, KIND_IMAGE, OPERATION_CUT, None, grid),
        ):
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                    " kind, operation, provider, request, status, source_job_id, output,"
                    " created_at, finished_at)"
                    " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'p',"
                    " CAST(:request AS jsonb), :status, :source,"
                    " jsonb_build_object('url', CAST(:url AS text)), :at, :at)"
                ),
                {
                    "id": job_id,
                    "owner": seed.sara,
                    "conversation_id": conversation_id,
                    "kind": kind,
                    "operation": operation,
                    "request": request,
                    "status": STATUS_COMPLETED,
                    "source": source,
                    "url": f"https://example.test/{job_id}",
                    "at": at,
                },
            )

    assert await reports.overall(Scope(since=EVER)) == before
    assert await reports.by_user(Scope(since=EVER)) == before_users
    assert await executions_by_id(service) == before_executions


async def test_subtitle_records_do_not_count_toward_any_metric(
    reports: PgAuditReports, service: AuditService, seed: Seed, engine: AsyncEngine
) -> None:
    before = await reports.overall(Scope(since=EVER))
    before_users = await reports.by_user(Scope(since=EVER))
    before_executions = await executions_by_id(service)
    at = ago(hours=1)
    async with engine.begin() as conn:
        for status, sentences in (
            (STATUS_COMPLETED, '{"sentences": []}'),
            (STATUS_FAILED, None),
            (STATUS_SUBMITTED, None),
        ):
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                    " kind, operation, provider, request, status, source_job_id, output,"
                    " created_at, submitted_at, finished_at)"
                    " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'qwen_asr',"
                    " CAST(:request AS jsonb), :status, :source, CAST(:sentences AS jsonb),"
                    " :at, :at, :finished_at)"
                ),
                {
                    "id": uuid.uuid4(),
                    "owner": seed.sara,
                    "conversation_id": seed.c1,
                    "kind": KIND_SUBTITLE,
                    "operation": OPERATION_GENERATE,
                    "request": json.dumps({"model": "m", "videoUrl": "https://example.test/v"}),
                    "status": status,
                    "source": seed.c1_shot1_video,
                    "sentences": sentences,
                    "at": at,
                    "finished_at": None if status == STATUS_SUBMITTED else at,
                },
            )

    assert await reports.overall(Scope(since=EVER)) == before
    assert await reports.by_user(Scope(since=EVER)) == before_users
    assert await executions_by_id(service) == before_executions


async def plant_conversation(
    conn: AsyncConnection,
    *,
    owner: uuid.UUID,
    at: datetime,
    forked_from: uuid.UUID | None = None,
) -> uuid.UUID:
    conversation_id = uuid.uuid4()
    await conn.execute(
        text(
            "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
            " updated_at, forked_from, fork_turn)"
            " VALUES (:id, :owner, 'agent', :title, :at, :at, :forked_from, :fork_turn)"
        ),
        {
            "id": conversation_id,
            "owner": owner,
            "title": f"对话 {conversation_id}",
            "at": at,
            "forked_from": forked_from,
            "fork_turn": None if forked_from is None else 1,
        },
    )
    await open_session(conn, conversation_id)
    return conversation_id


async def plant_take(
    conn: AsyncConnection, conversation_id: uuid.UUID, *, owner: uuid.UUID, shot: int, at: datetime
) -> uuid.UUID:
    take = uuid.uuid4()
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, shot_index,"
            " kind, operation, provider, request, status, output, created_at, submitted_at,"
            " finished_at)"
            " VALUES (:id, :owner, :conversation_id, :shot, :kind, :operation, 'p',"
            " CAST(:request AS jsonb), :status, jsonb_build_object('url', CAST(:url AS text)),"
            " :at, :at, :at)"
        ),
        {
            "id": take,
            "owner": owner,
            "conversation_id": conversation_id,
            "shot": shot,
            "kind": KIND_VIDEO,
            "operation": OPERATION_GENERATE,
            "request": json.dumps({"model": "m", "prompt": "p"}),
            "status": STATUS_COMPLETED,
            "url": f"https://example.test/{take}.mp4",
            "at": at,
        },
    )
    return take


async def plant_composite(
    conn: AsyncConnection,
    conversation_id: uuid.UUID,
    *,
    owner: uuid.UUID,
    base: uuid.UUID,
    at: datetime,
) -> uuid.UUID:
    composite = uuid.uuid4()
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, shot_index,"
            " kind, operation, provider, request, status, source_job_id, root_job_id,"
            " output, created_at, submitted_at, finished_at)"
            " SELECT :id, :owner, CAST(:conversation_id AS uuid), shot_index, :kind, :operation,"
            " 'ffmpeg', CAST(:request AS jsonb), :status, id, id,"
            " jsonb_build_object('url', CAST(:url AS text)), :at, :at, :at"
            " FROM iclip.generation_jobs WHERE id = :base"
        ),
        {
            "id": composite,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_COMPOSE,
            "request": json.dumps(
                {
                    "segments": [
                        {
                            "sourceJobId": str(base),
                            "url": "https://example.test/b.mp4",
                            "start": 0,
                            "end": 3,
                        }
                    ]
                }
            ),
            "status": STATUS_COMPLETED,
            "base": base,
            "url": f"https://example.test/{composite}.mp4",
            "at": at,
        },
    )
    return composite


async def plant_download(conn: AsyncConnection, job_id: uuid.UUID, *, user_id: uuid.UUID) -> None:
    await conn.execute(
        text(
            "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at)"
            " VALUES (:id, :name, :job_id, :user_id, now())"
        ),
        {"id": uuid.uuid4(), "name": VIDEO_DOWNLOADED, "job_id": job_id, "user_id": user_id},
    )


async def test_a_composite_downloaded_in_a_fork_counts_toward_the_ancestors_shot(
    reports: PgAuditReports, service: AuditService, seed: Seed, engine: AsyncEngine
) -> None:
    before = await reports.overall(Scope(since=EVER))
    at = ago(minutes=30)
    async with engine.begin() as conn:
        source = await plant_conversation(conn, owner=seed.sara, at=ago(hours=1))
        one, _, _ = [
            await plant_take(conn, source, owner=seed.sara, shot=shot, at=ago(minutes=50))
            for shot in (1, 2, 3)
        ]
        fork = await plant_conversation(
            conn, owner=seed.derek, at=ago(minutes=40), forked_from=source
        )
        own = await plant_take(conn, fork, owner=seed.derek, shot=4, at=at)
        composite = await plant_composite(conn, fork, owner=seed.derek, base=one, at=at)
        await plant_download(conn, composite, user_id=seed.derek)
        await plant_download(conn, own, user_id=seed.derek)

    overall = await reports.overall(Scope(since=EVER))
    assert (overall.shots, overall.effective_shots) == (
        before.shots + 3,
        before.effective_shots + 1,
    )
    executions = await executions_by_id(service)
    assert fork not in executions
    assert [(shot.shot, shot.effective) for shot in executions[source].shots] == [
        (1, True),
        (2, False),
        (3, False),
    ]


@dataclass(frozen=True)
class ThreeShots:
    conn: AsyncConnection
    conversation: uuid.UUID
    owner: uuid.UUID
    first: uuid.UUID
    second: uuid.UUID
    at: datetime

    async def derive(
        self,
        *,
        kind: str,
        operation: str,
        request: dict[str, Any],
        source: uuid.UUID | None = None,
        root: uuid.UUID | None = None,
        conversation: uuid.UUID | None = None,
    ) -> uuid.UUID:
        job = uuid.uuid4()
        await self.conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, source_job_id, root_job_id, output,"
                " created_at, submitted_at, finished_at)"
                " VALUES (:id, :owner, CAST(:conversation AS uuid), :kind, :operation, 'p',"
                " CAST(:request AS jsonb), :status, CAST(:source AS uuid), CAST(:root AS uuid),"
                " jsonb_build_object('url', CAST(:url AS text)), :at, :at, :at)"
            ),
            {
                "id": job,
                "owner": self.owner,
                "conversation": conversation,
                "kind": kind,
                "operation": operation,
                "request": json.dumps(request),
                "status": STATUS_COMPLETED,
                "source": source,
                "root": root,
                "url": f"https://example.test/{job}.mp4",
                "at": self.at,
            },
        )
        return job

    async def film(self, *videos: uuid.UUID) -> uuid.UUID:
        return await self.derive(
            kind=KIND_WHOLE_FILM,
            operation=OPERATION_RENDER,
            request={"videos": [{"jobId": str(video)} for video in videos]},
            conversation=self.conversation,
        )

    async def high_definition(self, source: uuid.UUID) -> uuid.UUID:
        return await self.derive(
            kind=KIND_VIDEO,
            operation=OPERATION_ENHANCE,
            request={"model": "video-enhance", "resolution": "1080p"},
            source=source,
        )


async def film_of_two_shots(shots: ThreeShots) -> uuid.UUID:
    return await shots.film(shots.first, shots.second)


async def high_definition_of_a_film(shots: ThreeShots) -> uuid.UUID:
    return await shots.high_definition(await film_of_two_shots(shots))


async def high_definition_of_a_take(shots: ThreeShots) -> uuid.UUID:
    return await shots.high_definition(shots.first)


async def edit_of_a_take(shots: ThreeShots) -> uuid.UUID:
    return await shots.derive(
        kind=KIND_VIDEO,
        operation=OPERATION_GENERATE,
        request={"model": "m", "prompt": "p", "range_start_ms": 0, "range_end_ms": 1000},
        source=shots.first,
        root=shots.first,
        conversation=shots.conversation,
    )


async def film_holding_a_composite(shots: ThreeShots) -> uuid.UUID:
    return await shots.film(
        await plant_composite(
            shots.conn, shots.conversation, owner=shots.owner, base=shots.first, at=shots.at
        )
    )


@pytest.mark.parametrize(
    ("downloaded", "effective"),
    [
        (film_of_two_shots, [True, True, False]),
        (high_definition_of_a_film, [True, True, False]),
        (high_definition_of_a_take, [True, False, False]),
        (edit_of_a_take, [True, False, False]),
        (film_holding_a_composite, [True, False, False]),
    ],
)
async def test_a_download_makes_the_shots_it_came_from_effective(
    reports: PgAuditReports,
    service: AuditService,
    seed: Seed,
    engine: AsyncEngine,
    downloaded: Callable[[ThreeShots], Awaitable[uuid.UUID]],
    effective: list[bool],
) -> None:
    before = await reports.overall(Scope(since=EVER))
    at = ago(minutes=30)
    async with engine.begin() as conn:
        conversation = await plant_conversation(conn, owner=seed.sara, at=ago(hours=1))
        first, second, _ = [
            await plant_take(conn, conversation, owner=seed.sara, shot=shot, at=ago(minutes=50))
            for shot in (1, 2, 3)
        ]
        file = await downloaded(
            ThreeShots(conn, conversation, seed.sara, first, second, at),
        )
        await plant_download(conn, file, user_id=seed.derek)

    overall = await reports.overall(Scope(since=EVER))
    assert (overall.shots, overall.effective_shots) == (
        before.shots + 3,
        before.effective_shots + sum(effective),
    )
    executions = await executions_by_id(service)
    assert [shot.effective for shot in executions[conversation].shots] == effective


async def test_audio_records_do_not_count_toward_any_metric(
    reports: PgAuditReports, service: AuditService, seed: Seed, engine: AsyncEngine
) -> None:
    before = await reports.overall(Scope(since=EVER))
    before_users = await reports.by_user(Scope(since=EVER))
    before_executions = await executions_by_id(service)
    at = ago(hours=1)
    rows: list[dict[str, Any]] = [
        {
            "conversation_id": seed.c1,
            "operation": OPERATION_GENERATE,
            "request": json.dumps({"model": "m", "prompt": "轻快"}),
            "status": status,
            "output": json.dumps({"url": "https://example.test/m.m4a", "duration_ms": 30_000})
            if status == STATUS_COMPLETED
            else None,
            "finished_at": None if status == STATUS_SUBMITTED else at,
        }
        for status in (STATUS_COMPLETED, STATUS_FAILED, STATUS_SUBMITTED)
    ]
    rows.append(
        {
            "conversation_id": None,
            "operation": OPERATION_UPLOAD,
            "request": None,
            "status": STATUS_COMPLETED,
            "output": json.dumps({"url": "https://example.test/u.mp3"}),
            "finished_at": at,
        }
    )
    async with engine.begin() as conn:
        for row in rows:
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id,"
                    " kind, operation, provider, request, status, output,"
                    " created_at, submitted_at, finished_at)"
                    " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'qwen_music',"
                    " CAST(:request AS jsonb), :status, CAST(:output AS jsonb),"
                    " :at, :at, :finished_at)"
                ),
                {"id": uuid.uuid4(), "owner": seed.sara, "kind": KIND_AUDIO, "at": at, **row},
            )

    assert await reports.overall(Scope(since=EVER)) == before
    assert await reports.by_user(Scope(since=EVER)) == before_users
    assert await executions_by_id(service) == before_executions


async def test_audit_connections_turn_off_jit_only_for_their_own_transaction(
    migrated_pg: str,
) -> None:
    engine = build_engine(
        migrated_pg,
        pool_size=1,
        max_overflow=0,
        connect_args={"server_settings": {"jit": "on"}},
    )
    probe = text("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")
    try:
        async with engine.connect() as conn:
            before = (await conn.execute(probe)).one()
        async with audit_connection(engine) as conn:
            inside = (await conn.execute(probe)).one()
        async with engine.connect() as conn:
            after = (await conn.execute(probe)).one()
    finally:
        await engine.dispose()

    assert (before.jit, inside.jit, after.jit) == ("on", "off", "on")
    assert before.pid == inside.pid == after.pid
