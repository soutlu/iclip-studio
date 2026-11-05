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


def by_id(page: AuditExecutionsOut) -> dict[uuid.UUID, ExecutionOut]:
    return {item.conversation_id: item for item in page.items}


async def test_conversation_belongs_to_latest_run_else_latest_video_owner(
    engine: AsyncEngine, reports: PgAuditReports, service: AuditService
) -> None:
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
    people = await reports.by_user(Scope(since=SINCE))

    assert (rows[a].user_name, rows[b].user_name) == (SARA, EVA)
    assert (people[DEREK].completed_videos, people[DEREK].delivered_conversations) == (1, 0)
    assert (people[SARA].completed_videos, people[SARA].delivered_conversations) == (2, 1)
    assert people[EVA].delivered_conversations == 1
    assert [people[name].usage.total_tokens for name in (EVA, DEREK, SARA)] == [700, 0, 0]


async def plant_sortable(
    engine: AsyncEngine,
) -> dict[ExecutionSort, dict[uuid.UUID, SortValue | None]]:
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


async def test_only_successful_takes_count_on_the_row(
    engine: AsyncEngine, service: AuditService
) -> None:
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
        for hours in range(6):
            await delivered(plant, sara, at=ago(hours=hours + 1), tokens=10)

    first = await service.executions(since=SINCE, sort="tokens", limit=2)

    assert [(row.conversation_id, row.anomalies) for row in first.items] == [
        (retried, ["retry", "stuck", "spend"]),
        (stalled, ["stuck", "spend", "task_stuck"]),
    ]
    assert (first.total, first.flagged) == (10, 4)
    assert first.thresholds.spend_tokens == pytest.approx((6000 + 5000 + 60) / 7 * 3)
