"""按人页签的 Postgres 口径：谁上榜、成片去重、按粒度铺满的每期成片数与排序。"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.audit.reports_pg import PgAuditReports
from iclip.domains.audit.service import AuditService
from iclip.domains.generation.models import STATUS_FAILED
from tests.helpers.audit import Plant

SINGAPORE = ZoneInfo("Asia/Singapore")
DAY0 = date(2026, 8, 3)
SARA = "Sara.Hong"
DEREK = "Derek.Lam"
EVA = "Eva.Lin"
IAN = "Ian.Wen"
FELIX = "Felix.Quan"


def local(day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime.combine(DAY0 + timedelta(days=day), time(hour, minute), tzinfo=SINGAPORE)


@pytest.fixture
def service(engine: AsyncEngine) -> AuditService:
    return AuditService(PgAuditReports(engine))


async def plant_people(engine: AsyncEngine) -> None:
    """新加坡 8 月 3 日起一周。Sara：需求单 A 当天两段对话各出一次片（算一件），第 2 天一段没挂单的
    对话出片，第 1 天跑一轮，窗外前一天还有一件。Derek 与 Eva 各一件、各跑三轮。Ian 只跑了五轮。
    Felix 窗里只有一次失败的出片、运行在窗外：既没出片也没跑，不上榜。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        sara, derek, eva, felix = [await plant.user(name) for name in (SARA, DEREK, EVA, FELIX)]
        task_a, task_b, task_c = [await plant.task(sara, at=local(-7)) for _ in range(3)]

        async def delivered(owner: uuid.UUID, at: datetime, task_id: uuid.UUID | None) -> None:
            conversation_id = await plant.conversation(owner, at=at, task_id=task_id)
            await plant.video(
                conversation_id,
                owner=owner,
                shot=1,
                created_at=at,
                finished_at=at + timedelta(minutes=5),
            )

        await delivered(sara, local(0, 12), task_a)
        await delivered(sara, local(0, 18), task_a)
        await delivered(sara, local(2, 12), None)
        await delivered(sara, local(-1, 12), None)
        await delivered(derek, local(1, 12), task_b)
        await delivered(eva, local(4, 12), task_c)

        chat = await plant.conversation(sara, at=local(-7))
        turns = [(1, SARA)] + [(1, DEREK)] * 3 + [(3, EVA)] * 3 + [(3, IAN)] * 5 + [(-2, FELIX)]
        for index, (day, name) in enumerate(turns):
            at = local(day, 9, index)
            await plant.turn(
                chat, user_name=name, started_at=at, ended_at=at + timedelta(minutes=1)
            )

        failed = await plant.conversation(felix, at=local(0, 10))
        await plant.video(
            failed,
            owner=felix,
            shot=1,
            status=STATUS_FAILED,
            created_at=local(0, 10, 30),
            finished_at=local(0, 10, 31),
        )


async def test_daily_people_rank_dedupe_and_fill_every_day(
    engine: AsyncEngine, service: AuditService
) -> None:
    """成片多的在前，同数看运行次数，再同按名字；只跑过的人排在后面也在。同一需求单两段对话只算
    一件，当天的每期成片数也只算一件；窗外的那件不算。每人的趋势七天每天都在，没成片的天是 0。"""

    await plant_people(engine)

    found = await service.people(since=local(0), until=local(7), timezone="Asia/Singapore")

    assert found.bucket == "day"
    assert [person.user_name for person in found.items] == [SARA, DEREK, EVA, IAN]
    by_name = {person.user_name: person for person in found.items}
    assert [(p.metrics.deliveries, p.metrics.runs) for p in found.items] == [
        (2, 1),
        (1, 3),
        (1, 3),
        (0, 5),
    ]
    days = [local(offset) for offset in range(7)]
    for person in found.items:
        assert [point.period_start for point in person.trend] == days
    assert [p.deliveries for p in by_name[SARA].trend] == [1, 0, 1, 0, 0, 0, 0]
    assert [p.deliveries for p in by_name[DEREK].trend] == [0, 1, 0, 0, 0, 0, 0]
    assert [p.deliveries for p in by_name[EVA].trend] == [0, 0, 0, 0, 1, 0, 0]
    assert [p.deliveries for p in by_name[IAN].trend] == [0] * 7


async def test_hourly_people_only_list_who_delivered_or_ran_in_the_window(
    engine: AsyncEngine, service: AuditService
) -> None:
    """两天内按小时：8 月 3 日 10:00–14:00 只有 Sara 12:05 那件；Felix 同一窗里的失败出片不算。"""

    await plant_people(engine)

    found = await service.people(since=local(0, 10), until=local(0, 14), timezone="Asia/Singapore")

    assert found.bucket == "hour"
    [sara] = found.items
    assert sara.user_name == SARA
    assert [point.period_start for point in sara.trend] == [
        local(0, hour) for hour in range(10, 14)
    ]
    assert [point.deliveries for point in sara.trend] == [0, 0, 1, 0]
    assert (sara.metrics.deliveries, sara.metrics.runs) == (1, 0)
