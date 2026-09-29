"""审计总览的 Postgres 口径：运行时长、单任务时长、片长与废片，以及总览的分期、均线与前几镜。

运行时长先真跑运行驱动，确认官方运行持久化落下的就是报表读的那几种事件；其余用原生 SQL 直插，
时间戳自己定。"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from pydantic_ai.messages import ModelMessage
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.audit.models import Scope
from iclip.domains.audit.reports_pg import PgAuditReports
from iclip.domains.audit.schemas import MetricsOut
from iclip.domains.audit.service import AuditService
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED
from iclip.harness.agents import (
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
    subagent_profiles,
)
from iclip.harness.jobs import JobQueue
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from tests.helpers.agents import spec_path
from tests.helpers.audit import Plant
from tests.helpers.runtime import (
    AGENT_ID,
    build_runner,
    calls_tool,
    delegates,
    discarding_usage_ledger,
    drained,
    first_run_messages,
    make_runner,
    plant_interrupted,
    says,
    submit_text,
)

SARA = "Sara.Hong"
DEREK = "Derek.Lam"
EVA = "Eva.Lin"
SINGAPORE = ZoneInfo("Asia/Singapore")
T0 = datetime(2026, 6, 1, 2, tzinfo=UTC)


def minutes(count: float) -> datetime:
    return T0 + timedelta(minutes=count)


def local(day: date, hour: int = 0, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=SINGAPORE).astimezone(UTC)


@pytest.fixture
def reports(engine: AsyncEngine) -> PgAuditReports:
    return PgAuditReports(engine)


@pytest.fixture
def service(reports: PgAuditReports) -> AuditService:
    return AuditService(reports)


# --- agent 运行时长：真跑运行驱动 ------------------------------------------------


WRITER = "shot-writer"


def delegating_runner(
    engine: AsyncEngine, root: Path
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    """按真实装配路径建一个会派活给子代理的主 agent，再按生产接法装 runner。"""

    step_store = PgStepStore(engine)
    store = TranscriptStore()
    models = {AGENT_ID: delegates((WRITER, "写三个镜头")), WRITER: says("写好了")}
    definitions = (
        AgentDefinition(
            agent_id=AGENT_ID,
            spec=spec_path(root, AGENT_ID),
            model=AGENT_ID,
            subagents=(
                SubAgentDefinition(name=WRITER, spec=spec_path(root, WRITER), model=WRITER),
            ),
        ),
    )
    registry = build_agent_registry(
        definitions,
        step_store=step_store,
        usage_ledger=discarding_usage_ledger(),
        models=models,
        subagent_mirror=SubAgentMirror(live=store, profiles=subagent_profiles(definitions, models)),
    )
    return make_runner(
        engine, agents=registry.agents, step_store=step_store, store=store, context_limits={}
    )


def _boom() -> str:
    raise RuntimeError("工具炸了")


async def test_run_seconds_count_top_level_runs_that_reached_an_end(
    engine: AsyncEngine, reports: PgAuditReports, tmp_path: Path
) -> None:
    """跑完的一轮（派过一个子代理）、工具炸掉失败的一轮各算一轮；子代理自己的运行也落了开始与
    结束，但不在 agent_job_runs 里，不算；中断后没有终态的一轮不算。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        owner = await plant.user(SARA)
        delegated, failed, interrupted = [
            await plant.conversation(owner, at=datetime.now(UTC)) for _ in range(3)
        ]

    runner, step_store, queue = delegating_runner(engine, tmp_path)
    await submit_text(runner, queue, str(delegated), "给这条视频做分镜")
    await drained(queue, str(delegated))
    await runner.shutdown()

    failing, _, failing_queue = build_runner(
        engine, calls_tool("boom"), store=TranscriptStore(), tools=[_boom]
    )
    await submit_text(failing, failing_queue, str(failed), "出图")
    await drained(failing_queue, str(failed))
    await failing.shutdown()

    messages: list[ModelMessage] = first_run_messages("agent-dead0001")
    await plant_interrupted(
        engine, step_store, queue, str(interrupted), run_id="agent-dead0001", messages=messages
    )

    async with engine.connect() as conn:
        events = (
            await conn.execute(
                text(
                    "SELECT r.parent_run_id IS NULL AS top, j.run_id IS NOT NULL AS registered,"
                    " array_agg(e.kind ORDER BY e.seq) FILTER (WHERE e.kind LIKE 'run_%') AS kinds"
                    " FROM agent_runtime.runs r"
                    " LEFT JOIN agent_runtime.agent_job_runs j ON j.run_id = r.run_id"
                    " JOIN agent_runtime.events e ON e.run_id = r.run_id"
                    " GROUP BY r.run_id, r.parent_run_id, j.run_id"
                )
            )
        ).all()
    assert sorted((row.top, row.registered, tuple(row.kinds)) for row in events) == [
        (False, False, ("run_started", "run_completed")),
        (True, True, ("run_started",)),
        (True, True, ("run_started", "run_completed")),
        (True, True, ("run_started", "run_failed")),
    ]

    overall = await reports.overall(Scope())

    assert overall.runs == 3
    assert overall.agent_run_seconds is not None
    assert overall.agent_run_seconds.count == 2


# --- 单任务时长、运行时长与样本数：直插 --------------------------------------------


async def test_active_cycle_merges_gaps_up_to_thirty_minutes(
    engine: AsyncEngine, reports: PgAuditReports, service: AuditService
) -> None:
    """X 运行完 29 分钟后出片：空档照算，49 分钟。Y 空了 31 分钟：断开，两段各 10 分钟；成片后的
    那轮在交付周期外，不进单任务时长。Z 一轮跑了 60 分钟，期间一条失败出片，结束 20 分钟后再出片：
    空档对的是已合并段的结束，不是上一条出片的结束，所以整段 90 分钟。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        x, y, z = [await plant.conversation(sara, at=minutes(-5)) for _ in range(3)]
        for conversation_id in (x, y, z):
            await plant.turn(
                conversation_id,
                user_name=SARA,
                started_at=T0,
                ended_at=minutes(60 if conversation_id == z else 10),
            )
        await plant.video(
            x,
            owner=sara,
            shot=1,
            created_at=minutes(39),
            submitted_at=minutes(40),
            finished_at=minutes(49),
        )
        await plant.video(y, owner=sara, shot=1, created_at=minutes(41), finished_at=minutes(51))
        await plant.turn(y, user_name=SARA, started_at=minutes(120), ended_at=minutes(130))
        await plant.video(
            z,
            owner=sara,
            shot=1,
            status=STATUS_FAILED,
            created_at=minutes(5),
            finished_at=minutes(6),
        )
        await plant.video(z, owner=sara, shot=1, created_at=minutes(80), finished_at=minutes(90))
        # 开跑了没有终态的一轮：不算运行时长，也不当单任务时长的区间。
        prompt_id = await plant.prompt(z, user_name=SARA, at=minutes(95))
        await plant.run(prompt_id, started_at=minutes(95), ended_at=None)

    page = await service.executions(since=minutes(-10), limit=10)
    rows = {row.conversation_id: row.metrics for row in page.items}
    active = {key: value.active_cycle_seconds for key, value in rows.items()}
    wall = {key: value.cycle_seconds for key, value in rows.items()}

    assert {key: spread.avg if spread else None for key, spread in active.items()} == {
        x: 2940,
        y: 1200,
        z: 5400,
    }
    assert {key: spread.avg if spread else None for key, spread in wall.items()} == {
        x: 2940,
        y: 3060,
        z: 5400,
    }

    overall = await reports.overall(Scope())

    assert overall.active_cycle_seconds is not None and overall.cycle_seconds is not None
    assert (overall.active_cycle_seconds.count, overall.active_cycle_seconds.median) == (3, 2940)
    assert overall.cycle_seconds.count == 3
    assert overall.agent_run_seconds is not None
    assert overall.agent_run_seconds.count == 4
    assert overall.agent_run_seconds.avg == (600 + 600 + 600 + 3600) / 4
    # 只有 X 那条成片记了提交时刻：视频生成时长只有它一个样本。
    assert overall.upstream_seconds is not None
    assert (overall.upstream_seconds.count, overall.upstream_seconds.avg) == (1, 540)
    assert overall.runs == 5 and overall.active_users == 1


async def test_length_counts_only_known_durations_and_discards_all_but_the_last_take(
    engine: AsyncEngine, reports: PgAuditReports, service: AuditService
) -> None:
    """片长只读成片的 ``duration_ms``，空的不计；同一镜全时段最后一条以外的是废片——按时间窗、
    按人切开看也是，窗里或某人名下的最后一条不因此变成「最后一条」。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek = await plant.user(SARA), await plant.user(DEREK)
        takes = await plant.conversation(sara, at=T0)
        unknown = await plant.conversation(derek, at=T0)
        await plant.video(
            takes, owner=sara, shot=1, created_at=T0, finished_at=minutes(10), duration_ms=5000
        )
        await plant.video(
            takes,
            owner=derek,
            shot=1,
            created_at=minutes(20),
            finished_at=minutes(30),
            duration_ms=6000,
        )
        await plant.video(
            takes, owner=sara, shot=2, created_at=minutes(35), finished_at=minutes(40)
        )
        await plant.video(
            takes,
            owner=sara,
            shot=2,
            status=STATUS_FAILED,
            created_at=minutes(45),
            finished_at=minutes(46),
            duration_ms=7000,
        )
        await plant.video(unknown, owner=derek, shot=1, created_at=T0, finished_at=minutes(15))

    everything = await reports.overall(Scope())
    later = await reports.overall(Scope(since=minutes(25)))
    earlier = await reports.overall(Scope(until=minutes(25)))
    by_user = await reports.by_user(Scope())
    by_conversation = {
        row.conversation_id: row.metrics
        for row in (await service.executions(since=minutes(-1), limit=10)).items
    }

    def triple(found: MetricsOut) -> tuple[int, float, float]:
        return (found.length_videos, found.length_seconds, found.discarded_length_seconds)

    assert triple(everything) == (2, 11.0, 5.0)
    assert triple(later) == (1, 6.0, 0.0)
    assert triple(earlier) == (1, 5.0, 5.0)
    assert triple(by_user[SARA]) == (1, 5.0, 5.0)
    assert triple(by_user[DEREK]) == (1, 6.0, 0.0)
    assert triple(by_conversation[unknown]) == (0, 0.0, 0.0)


# --- 总览：分期、非活跃日、均线、前几镜 --------------------------------------------

DAY0 = date(2026, 8, 3)


async def plant_week(engine: AsyncEngine) -> dict[str, uuid.UUID]:
    """新加坡时区 8 月 3 日起的一周：第 2 天没人跑；第 3 天两个人跑。九张需求单与一段没挂单的对话
    共十件成片，需求单 1 在第 0、1 天各出一次片（算一件）。另有三镜重出过：挂在当天已有成片的
    需求单下，不添件数；失败的不计次数，其中一段对话已删。还有一镜只失败过，哪里都不出现。
    上一期只有一轮运行。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek, eva = [await plant.user(name) for name in (SARA, DEREK, EVA)]
        tasks = [await plant.task(sara, at=T0) for _ in range(9)]
        deliveries: list[tuple[int, uuid.UUID | None]] = [
            (0, tasks[0]),
            (0, tasks[1]),
            (1, tasks[0]),
            (1, tasks[2]),
            (3, tasks[3]),
            (3, tasks[4]),
            (4, tasks[5]),
            (4, tasks[6]),
            (5, tasks[7]),
            (6, tasks[8]),
            (6, None),
        ]
        for day, task_id in deliveries:
            at = local(DAY0 + timedelta(days=day), 12)
            conversation_id = await plant.conversation(sara, at=at, task_id=task_id)
            await plant.video(
                conversation_id,
                owner=sara,
                shot=1,
                created_at=at,
                finished_at=at + timedelta(minutes=5),
            )
            await plant.usage(conversation_id, tokens=100, last_at=at + timedelta(minutes=6))
        chat = await plant.conversation(sara, at=local(DAY0 - timedelta(days=7)))
        runs = [(0, SARA), (1, DEREK), (3, SARA), (3, EVA), (4, SARA), (5, SARA), (6, SARA)]
        for day, name in runs:
            at = local(DAY0 + timedelta(days=day), 9)
            await plant.turn(
                chat, user_name=name, started_at=at, ended_at=at + timedelta(minutes=2)
            )
        await plant.turn(
            chat,
            user_name=DEREK,
            started_at=local(DAY0 - timedelta(days=3), 9),
            ended_at=local(DAY0 - timedelta(days=3), 10),
        )

        retried = await plant.conversation(
            eva,
            at=local(DAY0, 8),
            task_id=tasks[3],
            title="重试最多",
            deleted_at=local(DAY0 + timedelta(days=5)),
        )
        latest = await plant.conversation(
            derek, at=local(DAY0, 8), task_id=tasks[5], title="最近重试"
        )
        fewer = await plant.conversation(
            sara, at=local(DAY0, 8), task_id=tasks[7], title="试了两次"
        )
        failed_only = await plant.conversation(sara, at=local(DAY0, 8), title="只失败过")
        # 每镜的出片按先后，``True`` 是成了；次数只数成了的。
        takes = [
            (retried, eva, 1, local(DAY0 + timedelta(days=3), 14), (True, True, True)),
            (latest, derek, 2, local(DAY0 + timedelta(days=4), 14), (False, True, True, True)),
            (fewer, sara, 1, local(DAY0 + timedelta(days=5), 14), (False,) * 3 + (True,) * 2),
            (failed_only, sara, 1, local(DAY0 + timedelta(days=6), 14), (False,) * 4),
        ]
        for conversation_id, owner, shot, first_at, outcomes in takes:
            for index, ok in enumerate(outcomes):
                at = first_at + timedelta(minutes=10 * index)
                await plant.video(
                    conversation_id,
                    owner=owner,
                    shot=shot,
                    status=STATUS_COMPLETED if ok else STATUS_FAILED,
                    created_at=at,
                    finished_at=at + timedelta(minutes=1),
                )
    return {"retried": retried, "latest": latest, "fewer": fewer}


async def test_daily_overview_marks_inactive_days_and_dedupes_deliveries(
    engine: AsyncEngine, service: AuditService
) -> None:
    ids = await plant_week(engine)
    since, until = local(DAY0), local(DAY0 + timedelta(days=7))

    overview = await service.overview(since=since, until=until, timezone="Asia/Singapore")

    window = overview.window
    assert (window.bucket, window.timezone) == ("day", "Asia/Singapore")
    assert (window.since, window.until) == (since, until)
    assert (window.previous_since, window.previous_until) == (since - timedelta(days=7), since)

    current = overview.current
    assert current.metrics.deliveries == 10
    assert current.metrics.runs == 7 and current.metrics.active_users == 3
    assert current.active_days == 6
    assert (overview.previous.metrics.runs, overview.previous.active_days) == (1, 1)

    series = overview.series
    assert [point.period_start for point in series] == [
        local(DAY0 + timedelta(days=offset)) for offset in range(7)
    ]
    assert [point.inactive for point in series] == [False, False, True, False, False, False, False]
    assert series[3].metrics.active_users == 2
    assert sum(point.metrics.deliveries for point in series) == 11

    # 最后一期的 7 日窗恰好就是本期，件数也够 10 件，不用往前补：每件成片的 token 与本期一致，
    # 分母是去重后的 10 件，不是各天件数相加的 11 件。
    ma7 = series[-1].ma7
    assert ma7 is not None
    assert (ma7.tokens_per_delivery.since, ma7.tokens_per_delivery.until) == (since, until)
    assert ma7.tokens_per_delivery.value == current.metrics.tokens_per_delivery == 110
    assert ma7.deliveries is not None and ma7.deliveries.since == since
    assert ma7.deliveries.value == pytest.approx(11 / 6)

    assert [
        (shot.conversation_id, shot.shot, shot.attempts, shot.title, shot.user_name)
        for shot in overview.top_shots
    ] == [
        (ids["latest"], 2, 3, "最近重试", DEREK),
        (ids["retried"], 1, 3, "重试最多", EVA),
        (ids["fewer"], 1, 2, "试了两次", SARA),
    ]
    assert [(row.attempts, row.shots) for row in overview.attempt_distribution] == [
        (1, 11),
        (2, 1),
        (3, 2),
    ]


async def test_a_shot_lands_on_its_first_success_and_belongs_to_its_owner(
    engine: AsyncEngine, reports: PgAuditReports
) -> None:
    """Sara 第 1 天先失败一次；Derek 那条第 1 天深夜受理、第 2 天凌晨完成，是第一条成功；Sara
    第 2 天再成一次。镜落在第 2 天（第一条成功生成的完成时刻，不是它的受理时刻，也不是第一次
    出片），归 Derek，次数 2；第 1 天什么都不算。"""

    day1, day2, day3 = (DAY0 + timedelta(days=offset) for offset in range(3))
    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek = await plant.user(SARA), await plant.user(DEREK)
        conversation_id = await plant.conversation(sara, at=local(day1, 8))
        for owner, status, created_at, finished_at in (
            (sara, STATUS_FAILED, local(day1, 9), local(day1, 9, 5)),
            (derek, STATUS_COMPLETED, local(day1, 23, 50), local(day2, 0, 10)),
            (sara, STATUS_COMPLETED, local(day2, 1), local(day2, 1, 10)),
        ):
            await plant.video(
                conversation_id,
                owner=owner,
                shot=1,
                status=status,
                created_at=created_at,
                finished_at=finished_at,
            )

    first_day = Scope(since=local(day1), until=local(day2))
    second_day = Scope(since=local(day2), until=local(day3))

    days = await reports.by_period(
        Scope(since=local(day1), until=local(day3)), bucket="day", timezone="Asia/Singapore"
    )
    assert [(row.metrics.shots, row.metrics.attempts) for row in days] == [(0, 0), (1, 2)]
    assert (await reports.overall(first_day)).shots == 0
    second = await reports.overall(second_day)
    assert (second.shots, second.attempts, second.one_take_shots) == (1, 2, 0)
    assert await reports.attempt_distribution(first_day) == []
    assert [
        (row.attempts, row.shots) for row in await reports.attempt_distribution(second_day)
    ] == [(2, 1)]
    assert await reports.top_shots(first_day, limit=3) == []
    assert [
        (shot.conversation_id, shot.shot, shot.attempts)
        for shot in await reports.top_shots(second_day, limit=3)
    ] == [(conversation_id, 1, 2)]
    people = await reports.by_user(Scope())
    assert (people[DEREK].shots, people[DEREK].attempts) == (1, 2)
    assert (people[SARA].shots, people[SARA].attempts) == (0, 0)


async def test_hourly_overview_clips_the_first_period_and_counts_active_days_exactly(
    engine: AsyncEngine, service: AuditService
) -> None:
    """两天内按小时。起点 00:30 不在整点上：首期期首报 00:00，指标只算 00:30 之后。上一期同一天
    05:00 有一轮，但在上一期的时间窗外，那天不算活跃日。"""

    day = date(2026, 8, 20)
    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        chat = await plant.conversation(sara, at=local(day - timedelta(days=2)))
        for at in (local(day, 0, 10), local(day, 0, 40), local(day, 2, 5)):
            await plant.turn(
                chat, user_name=SARA, started_at=at, ended_at=at + timedelta(minutes=5)
            )
        await plant.turn(
            chat,
            user_name=SARA,
            started_at=local(day - timedelta(days=1), 5),
            ended_at=local(day - timedelta(days=1), 6),
        )
        await plant.video(
            chat, owner=sara, shot=1, created_at=local(day, 1, 10), finished_at=local(day, 1, 30)
        )

    overview = await service.overview(
        since=local(day, 0, 30), until=local(day, 3), timezone="Asia/Singapore"
    )

    assert overview.window.bucket == "hour"
    assert [point.period_start for point in overview.series] == [
        local(day, hour) for hour in range(3)
    ]
    assert [point.metrics.runs for point in overview.series] == [1, 0, 1]
    assert [point.metrics.completed_videos for point in overview.series] == [0, 1, 0]
    assert not any(point.inactive for point in overview.series)
    assert (overview.current.metrics.runs, overview.current.active_days) == (2, 1)
    assert (overview.previous.metrics.runs, overview.previous.active_days) == (0, 0)
    last = overview.series[-1].ma7
    assert last is not None
    assert last.deliveries is None and last.total_tokens is None
    assert last.attempts_per_shot.value == 1 and last.attempts_per_shot.until == local(day, 3)


async def test_weekly_overview_has_no_moving_averages(
    engine: AsyncEngine, service: AuditService
) -> None:
    monday = date(2026, 3, 2)
    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        chat = await plant.conversation(sara, at=local(monday))
        at = local(monday + timedelta(days=40), 9)
        await plant.turn(chat, user_name=SARA, started_at=at, ended_at=at + timedelta(minutes=1))

    overview = await service.overview(
        since=local(monday) + timedelta(hours=9),
        until=local(monday + timedelta(days=130)),
        timezone="Asia/Singapore",
    )

    starts = [point.period_start for point in overview.series]
    assert overview.window.bucket == "week"
    assert starts[0] == local(monday)
    assert all(start.astimezone(SINGAPORE).weekday() == 0 for start in starts)
    assert len(starts) == 19
    assert all(point.ma7 is None and point.ma30 is None for point in overview.series)
    assert not any(point.inactive for point in overview.series)
    assert sum(point.metrics.runs for point in overview.series) == 1
