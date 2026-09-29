"""任务执行清单的 Postgres 口径：对话归属人、四种排序键的升降与跨空值翻页、userName 只筛行、四种异常、
行上的镜只数成功的生成，以及整个筛选范围的条数。

视频悬挂按此刻判，样本都相对测试开始的此刻 ``BASE`` 往过去放。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.audit.executions import SortValue
from iclip.domains.audit.models import ExecutionSort, Scope, SortOrder
from iclip.domains.audit.reports_pg import PgAuditReports
from iclip.domains.audit.schemas import AuditExecutionsOut, ExecutionOut
from iclip.domains.audit.service import AuditService
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
)
from tests.helpers.audit import Plant

BASE = datetime.now(UTC).replace(microsecond=0)
SARA = "Sara.Hong"
DEREK = "Derek.Lam"
EVA = "Eva.Lin"


def ago(**delta: float) -> datetime:
    return BASE - timedelta(**delta)


SINCE = ago(days=2)


@pytest.fixture
def service(engine: AsyncEngine) -> AuditService:
    return AuditService(PgAuditReports(engine))


def by_id(page: AuditExecutionsOut) -> dict[uuid.UUID, ExecutionOut]:
    return {item.conversation_id: item for item in page.items}


# --- 对话归属人 ---------------------------------------------------------------------


async def test_conversation_belongs_to_latest_run_else_latest_video_owner(
    engine: AsyncEngine, service: AuditService
) -> None:
    """A 没跑过：Derek 先出片、Sara 后出片，归 Sara。B 先 Derek 后 Eva 各跑一轮，Sara 的出片
    还在最后：有运行就以最近一轮为准，归 Eva。视频本身仍归属主；交付周期与用量跟对话归属人走。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek = await plant.user(SARA), await plant.user(DEREK)
        a = await plant.conversation(sara, at=ago(hours=6))
        for owner, shot, hours in ((derek, 1, 5), (sara, 2, 4)):
            await plant.video(
                a,
                owner=owner,
                shot=shot,
                created_at=ago(hours=hours),
                finished_at=ago(hours=hours) + timedelta(minutes=5),
            )
        b = await plant.conversation(sara, at=ago(hours=6))
        for name, hours in ((DEREK, 3), (EVA, 2)):
            await plant.turn(b, user_name=name, started_at=ago(hours=hours), ended_at=None)
        await plant.video(
            b,
            owner=sara,
            shot=1,
            created_at=ago(hours=1),
            finished_at=ago(hours=1) + timedelta(minutes=5),
        )
        await plant.usage(b, tokens=700, last_at=ago(minutes=30))

    rows = by_id(await service.executions(since=SINCE))
    people = await PgAuditReports(engine).by_user(Scope())

    assert (rows[a].user_name, rows[b].user_name) == (SARA, EVA)
    assert (people[DEREK].completed_videos, people[DEREK].delivered_conversations) == (1, 0)
    assert (people[SARA].completed_videos, people[SARA].delivered_conversations) == (2, 1)
    assert people[EVA].delivered_conversations == 1
    assert [people[name].usage.total_tokens for name in (EVA, DEREK, SARA)] == [700, 0, 0]


# --- 排序与翻页 ---------------------------------------------------------------------


async def plant_sortable(
    engine: AsyncEngine,
) -> dict[ExecutionSort, dict[uuid.UUID, SortValue | None]]:
    """六段执行，四种排序键各自的取值；每镜重试与 token 有并列，每镜重试与运行时长还有空值。
    重试只数成功的生成，空值恰好都是没有成片的那几段。

    E1 一镜一次成片（重试 1、运行 600 秒、token 500）；E2 一镜失败一次再成两次（2、1320 秒、100）；
    E3 只跑过（空、空、300）；E4 一镜成一次、另一镜失败一次再成（1、300 秒、没有用量算 0）；E5 只跑
    过、没有用量（空、空、0）；E6 一镜只失败了一次（没有成功镜为空、没成片为空、200）。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        created = [ago(hours=10 - index) for index in range(6)]
        e1, e2, e3, e4, e5, e6 = [await plant.conversation(sara, at=at) for at in created]

        async def take(
            conversation_id: uuid.UUID,
            shot: int,
            start: datetime,
            minutes: float,
            status: str = STATUS_COMPLETED,
        ) -> None:
            await plant.video(
                conversation_id,
                owner=sara,
                shot=shot,
                status=status,
                created_at=start,
                finished_at=start + timedelta(minutes=minutes),
            )

        await take(e1, 1, created[0], 10)
        await take(e2, 1, created[1], 1, STATUS_FAILED)
        await take(e2, 1, created[1] + timedelta(minutes=2), 20)
        await take(e2, 1, created[1] + timedelta(minutes=3), 10)
        await take(e4, 1, created[3], 5)
        await take(e4, 2, created[3], 1, STATUS_FAILED)
        await take(e4, 2, created[3] + timedelta(minutes=1), 2)
        await take(e6, 1, created[5], 1, STATUS_FAILED)
        for conversation_id, at in ((e3, created[2]), (e5, created[4])):
            start = at + timedelta(minutes=1)
            await plant.turn(
                conversation_id,
                user_name=SARA,
                started_at=start,
                ended_at=start + timedelta(minutes=1),
            )
        for conversation_id, tokens in ((e1, 500), (e2, 100), (e3, 300), (e6, 200)):
            await plant.usage(conversation_id, tokens=tokens, last_at=BASE - timedelta(hours=1))

    return {
        "start": dict(zip((e1, e2, e3, e4, e5, e6), created, strict=True)),
        "retries": {e1: 1.0, e2: 2.0, e3: None, e4: 1.0, e5: None, e6: None},
        "cycle": {e1: 600.0, e2: 1320.0, e3: None, e4: 300.0, e5: None, e6: None},
        "tokens": {e1: 500, e2: 100, e3: 300, e4: 0, e5: 0, e6: 200},
    }


def expected_order(keys: Mapping[uuid.UUID, SortValue | None], order: SortOrder) -> list[uuid.UUID]:
    """按键排、同键按对话 id，方向一致；空值不论升降都在最后，彼此仍按 id 同方向排。"""

    descending = order == "desc"
    present = sorted(
        (key for key, value in keys.items() if value is not None),
        key=lambda key: (keys[key], key),
        reverse=descending,
    )
    blank = sorted((key for key, value in keys.items() if value is None), reverse=descending)
    return present + blank


async def read_all(
    service: AuditService, *, sort: ExecutionSort, order: SortOrder, limit: int
) -> list[AuditExecutionsOut]:
    pages = [await service.executions(since=SINCE, sort=sort, order=order, limit=limit)]
    while pages[-1].next_cursor is not None:
        pages.append(
            await service.executions(
                since=SINCE, sort=sort, order=order, limit=limit, cursor=pages[-1].next_cursor
            )
        )
        assert len(pages) <= 10, "翻页停不下来"
    return pages


@pytest.mark.parametrize("sort", ["start", "retries", "cycle", "tokens"])
@pytest.mark.parametrize("order", ["asc", "desc"])
async def test_every_sort_pages_through_without_gaps_or_repeats(
    engine: AsyncEngine, service: AuditService, sort: ExecutionSort, order: SortOrder
) -> None:
    """每镜重试与运行时长各有三个值、三个空值：每页两条、四条时在页中间跨过「有值 → 空值」，每页
    三条时恰在第一、二页之间跨过；空值不论升降都在最后。满页才给游标，最后一页恰好满时再取一次是
    空页，条数照旧；每页四条时第二页不满就停。"""

    keys = (await plant_sortable(engine))[sort]
    expected = expected_order(keys, order)
    page_sizes = {2: [2, 2, 2, 0], 3: [3, 3, 0], 4: [4, 2]}

    for limit, sizes in page_sizes.items():
        pages = await read_all(service, sort=sort, order=order, limit=limit)

        seen = [item.conversation_id for page in pages for item in page.items]
        assert seen == expected, (limit, [keys[key] for key in seen])
        assert all(page.total == 6 for page in pages)
        assert [len(page.items) for page in pages] == sizes


async def test_sort_values_match_the_row_details(
    engine: AsyncEngine, service: AuditService
) -> None:
    """排序键就是行上能看到的那几个数：每镜重试 = 行上各镜成功次数之和 ÷ 镜数，运行时长 = 单任务
    时长，token 合计。只失败过的 E6 与只跑过的两段一样没有镜，重试为空。"""

    keys = await plant_sortable(engine)
    rows = by_id(await service.executions(since=SINCE, limit=10))

    for conversation_id, row in rows.items():
        cycle = row.metrics.active_cycle_seconds
        retries = keys["retries"][conversation_id]
        assert row.metrics.attempts_per_shot == retries
        if retries is None:
            assert row.shots == []
        else:
            assert sum(shot.attempts for shot in row.shots) / len(row.shots) == retries
        assert (None if cycle is None else cycle.avg) == keys["cycle"][conversation_id]
        assert row.metrics.usage.total_tokens == keys["tokens"][conversation_id]
        assert row.created_at == keys["start"][conversation_id]


# --- 行上的镜与异常 -------------------------------------------------------------------


async def test_only_successful_takes_count_on_the_row(
    engine: AsyncEngine, service: AuditService
) -> None:
    """镜 1 五次出片按受理先后：失败、排队、成了、提交中、已提交，只有成了的那次算，之前失败过也是
    一次通过。镜 2 失败两次、还悬着一次，没成过就不算镜：不列在行上，也不进镜数。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        conversation_id = await plant.conversation(sara, at=ago(hours=5))
        for shot, statuses in (
            (
                1,
                (
                    STATUS_FAILED,
                    STATUS_PENDING,
                    STATUS_COMPLETED,
                    STATUS_SUBMITTING,
                    STATUS_SUBMITTED,
                ),
            ),
            (2, (STATUS_FAILED, STATUS_FAILED, STATUS_SUBMITTED)),
        ):
            for minute, status in enumerate(statuses):
                at = ago(hours=4) + timedelta(minutes=10 * shot + minute)
                await plant.video(
                    conversation_id,
                    owner=sara,
                    shot=shot,
                    status=status,
                    created_at=at,
                    finished_at=at if status in (STATUS_COMPLETED, STATUS_FAILED) else None,
                )

    [row] = (await service.executions(since=SINCE)).items

    assert [(shot.shot, shot.attempts, shot.one_take) for shot in row.shots] == [(1, 1, True)]
    assert (row.metrics.shots, row.metrics.attempts, row.metrics.one_take_shots) == (1, 1, 1)


async def test_retry_and_stuck_flag_on_their_thresholds(
    engine: AsyncEngine, service: AuditService
) -> None:
    """同一镜成功生成三次算反复重试，两次不算，失败三次再成一次也不算；停在 submitted 超过一小时
    算悬挂，半小时的、以及提交中与排队的老记录都不算。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        retried, twice, failed_thrice, stuck, fresh, other = [
            await plant.conversation(sara, at=ago(hours=10 - index)) for index in range(6)
        ]
        takes = (
            (retried, (STATUS_COMPLETED,) * 3),
            (twice, (STATUS_COMPLETED,) * 2),
            (failed_thrice, (STATUS_FAILED,) * 3 + (STATUS_COMPLETED,)),
        )
        for conversation_id, statuses in takes:
            for index, status in enumerate(statuses):
                at = ago(hours=4, minutes=-index)
                await plant.video(
                    conversation_id,
                    owner=sara,
                    shot=2,
                    status=status,
                    created_at=at,
                    finished_at=at,
                )
        # 另一镜只出一次：反复重试看的是单镜，不是整段对话的成功次数。
        await plant.video(
            twice, owner=sara, shot=1, created_at=ago(hours=4), finished_at=ago(hours=3)
        )
        await plant.video(
            stuck,
            owner=sara,
            shot=1,
            status=STATUS_SUBMITTED,
            created_at=ago(hours=2),
            submitted_at=ago(hours=2),
        )
        await plant.video(
            fresh,
            owner=sara,
            shot=1,
            status=STATUS_SUBMITTED,
            created_at=ago(minutes=30),
            submitted_at=ago(minutes=30),
        )
        for status in (STATUS_SUBMITTING, STATUS_PENDING):
            await plant.video(
                other,
                owner=sara,
                shot=1,
                status=status,
                created_at=ago(hours=5),
                submitted_at=ago(hours=5),
            )

    page = await service.executions(since=SINCE)
    rows = by_id(page)

    assert rows[retried].anomalies == ["retry"]
    assert rows[twice].anomalies == []
    assert rows[failed_thrice].anomalies == []
    assert rows[stuck].anomalies == ["stuck"]
    assert rows[fresh].anomalies == []
    assert rows[other].anomalies == []
    assert (page.thresholds.retry_at_least, page.thresholds.stuck_hours) == (3, 1)


async def delivered(
    plant: Plant, owner: uuid.UUID, *, at: datetime, tokens: int, run_by: str | None = None
) -> uuid.UUID:
    """一段没挂需求单、出了一件成片的对话，带这么多 token。"""

    conversation_id = await plant.conversation(owner, at=at)
    if run_by is not None:
        await plant.turn(conversation_id, user_name=run_by, started_at=at, ended_at=at)
    await plant.video(
        conversation_id,
        owner=owner,
        shot=1,
        created_at=at,
        finished_at=at + timedelta(minutes=5),
    )
    await plant.usage(conversation_id, tokens=tokens, last_at=at + timedelta(minutes=6))
    return conversation_id


async def test_spend_baseline_is_the_whole_window_regardless_of_user_filter(
    engine: AsyncEngine, service: AuditService
) -> None:
    """全窗四件成片共 1300 token，每件平均 325，门槛 975：Sara 那段 1000 超了。只看 Sara 时门槛
    不变、照样标出——若按 Sara 自己算，平均 1000、门槛 3000，就标不出来。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek = await plant.user(SARA), await plant.user(DEREK)
        big = await delivered(plant, sara, at=ago(hours=6), tokens=1000)
        for hours in (7, 8, 9):
            await delivered(plant, derek, at=ago(hours=hours), tokens=100)

    everyone = await service.executions(since=SINCE)
    only_sara = await service.executions(since=SINCE, user_name=SARA)

    assert everyone.thresholds.spend_tokens == only_sara.thresholds.spend_tokens == 975
    assert everyone.thresholds.spend_times == 3
    assert {row.conversation_id for row in everyone.items if row.anomalies} == {big}
    assert [(row.conversation_id, row.anomalies) for row in only_sara.items] == [(big, ["spend"])]
    assert (everyone.total, everyone.flagged) == (4, 1)
    assert (only_sara.total, only_sara.flagged) == (1, 1)


async def test_spend_is_off_when_the_window_has_no_delivery(
    engine: AsyncEngine, service: AuditService
) -> None:
    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        chat = await plant.conversation(sara, at=ago(hours=3))
        await plant.turn(chat, user_name=SARA, started_at=ago(hours=3), ended_at=ago(hours=2))
        await plant.usage(chat, tokens=10_000_000, last_at=ago(hours=2))

    page = await service.executions(since=SINCE)

    assert page.thresholds.spend_tokens is None
    assert [row.anomalies for row in page.items] == [[]]


async def test_task_stuck_needs_three_executions_in_window_and_no_delivery_ever(
    engine: AsyncEngine, service: AuditService
) -> None:
    """卡住的单：窗里三段执行、从没成片，三段都标，只看 Derek 时他那段也标（段数不看 userName）。
    反例：窗里三段没成片、但窗外早先有一段成过片的单；窗里只有两段、第三段在窗外的单；两段执行
    外加一段既没跑也没出片的对话（不算执行）的单。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek = await plant.user(SARA), await plant.user(DEREK)
        stuck, delivered_before, two_in_window, idle_third = [
            await plant.task(sara, at=ago(days=10)) for _ in range(4)
        ]

        async def attempt(task_id: uuid.UUID, *, at: datetime, by: str = SARA) -> uuid.UUID:
            conversation_id = await plant.conversation(sara, at=at, task_id=task_id)
            await plant.turn(conversation_id, user_name=by, started_at=at, ended_at=at)
            return conversation_id

        stuck_rows = [
            await attempt(stuck, at=ago(hours=5)),
            await attempt(stuck, at=ago(hours=4)),
            await attempt(stuck, at=ago(hours=3), by=DEREK),
        ]
        for hours in (5, 4, 3):
            await attempt(delivered_before, at=ago(hours=hours, minutes=10))
        earlier = await plant.conversation(sara, at=ago(days=5), task_id=delivered_before)
        await plant.video(
            earlier, owner=sara, shot=1, created_at=ago(days=5), finished_at=ago(days=5)
        )
        await attempt(two_in_window, at=ago(days=3))
        for hours in (5, 4):
            await attempt(two_in_window, at=ago(hours=hours, minutes=20))
        for hours in (5, 4):
            await attempt(idle_third, at=ago(hours=hours, minutes=30))
        await plant.conversation(sara, at=ago(hours=3), task_id=idle_third)
        # 一段有成片的对话，让本期有成片基准；它不挂单，不影响卡住判定。
        await delivered(plant, derek, at=ago(hours=1), tokens=0, run_by=DEREK)

    page = await service.executions(since=SINCE, limit=100)
    flagged = {row.conversation_id for row in page.items if "task_stuck" in row.anomalies}
    only_derek = await service.executions(since=SINCE, user_name=DEREK, limit=100)

    assert flagged == set(stuck_rows)
    assert (page.total, page.flagged) == (3 + 3 + 2 + 2 + 1, 3)
    assert page.thresholds.task_conversations == 3
    derek_rows = by_id(only_derek)
    assert derek_rows[stuck_rows[2]].anomalies == ["task_stuck"]
    assert (only_derek.total, only_derek.flagged) == (2, 1)


async def test_anomalies_come_in_a_fixed_order_and_totals_cover_every_page(
    engine: AsyncEngine, service: AuditService
) -> None:
    """反复重试要有成片、需求单卡住要从没成片，同一行不会两个都中，四种的顺序分两行看：一行没挂单、
    一镜成功三次、另一镜悬在上游、token 远超门槛，按 retry、stuck、spend 排；另一行挂在卡住的单下、
    一镜悬在上游、token 也超了，按 stuck、spend、task_stuck 排。每页两条时条数与命中条数仍是整个
    范围的。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara = await plant.user(SARA)
        task_id = await plant.task(sara, at=ago(days=10))
        retried = await plant.conversation(sara, at=ago(hours=21))
        for index in range(3):
            at = ago(hours=20, minutes=-index)
            await plant.video(retried, owner=sara, shot=1, created_at=at, finished_at=at)
        stalled = await plant.conversation(sara, at=ago(hours=20), task_id=task_id)
        for conversation_id, tokens in ((retried, 6000), (stalled, 5000)):
            await plant.video(
                conversation_id,
                owner=sara,
                shot=2,
                status=STATUS_SUBMITTED,
                created_at=ago(hours=18),
                submitted_at=ago(hours=18),
            )
            await plant.usage(conversation_id, tokens=tokens, last_at=ago(hours=18))
        for hours in (17, 16):
            sibling = await plant.conversation(sara, at=ago(hours=hours), task_id=task_id)
            await plant.turn(sibling, user_name=SARA, started_at=ago(hours=hours), ended_at=None)
        # 六件各 10 token 的成片，连同重试的那段共七件：本期每件平均 (6000 + 5000 + 60) / 7，
        # 门槛约 4740。
        for hours in range(6):
            await delivered(plant, sara, at=ago(hours=hours + 1), tokens=10)

    first = await service.executions(since=SINCE, sort="tokens", limit=2)

    assert [(row.conversation_id, row.anomalies) for row in first.items] == [
        (retried, ["retry", "stuck", "spend"]),
        (stalled, ["stuck", "spend", "task_stuck"]),
    ]
    assert (first.total, first.flagged) == (10, 4)
    assert first.thresholds.spend_tokens == pytest.approx((6000 + 5000 + 60) / 7 * 3)
