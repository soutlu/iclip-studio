"""审计端点：治理者才能看，参数错给 422，空库回全零的形状；旧的三个端点已经没有了。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import httpx

from iclip.domains.audit.executions import ExecutionCursor, encode_execution_cursor
from tests.helpers.auth import register_and_login, set_roles_in_db

OVERVIEW = "/audit/overview"
PEOPLE = "/audit/people"
EXECUTIONS = "/audit/executions"
WEEK = {"since": "2026-09-01T00:00:00+08:00", "until": "2026-09-08T00:00:00+08:00"}


async def login_as(client: httpx.AsyncClient, pg_url: str, role: str) -> None:
    email = f"{role}@example.com"
    await register_and_login(client, username=role, email=email)
    await set_roles_in_db(pg_url, email, [role])


async def test_audit_is_for_governors_only(client: httpx.AsyncClient, pg_url: str) -> None:
    for url in (OVERVIEW, PEOPLE, EXECUTIONS):
        assert (await client.get(url, params=WEEK)).status_code == 401

    await login_as(client, pg_url, "editor")

    for url in (OVERVIEW, PEOPLE, EXECUTIONS):
        assert (await client.get(url, params=WEEK)).status_code == 403


async def test_retired_audit_endpoints_are_gone(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "root")

    for url in ("/audit/summary", "/audit/conversations", "/audit/anomalies"):
        assert (await client.get(url)).status_code == 404


async def test_governor_reads_an_empty_overview(client: httpx.AsyncClient, pg_url: str) -> None:
    """空库：一周按天七期，全是非活跃日，均线有窗没值；本期、上一期都是零。"""

    await login_as(client, pg_url, "root")

    response = await client.get(OVERVIEW, params={**WEEK, "timezone": "Asia/Singapore"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["window"]["bucket"] == "day"
    assert body["window"]["previousUntil"] == body["window"]["since"]
    assert body["current"]["activeDays"] == 0 and body["current"]["metrics"]["runs"] == 0
    assert body["previous"]["metrics"]["activeCycleSeconds"] is None
    assert len(body["series"]) == 7 and all(point["inactive"] for point in body["series"])
    ma7 = body["series"][-1]["ma7"]
    assert ma7["deliveries"]["value"] is None and ma7["tokensPerDelivery"]["value"] is None
    assert body["attemptDistribution"] == [] and body["topShots"] == []


async def test_governor_reads_empty_people_and_executions(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as(client, pg_url, "root")

    people = await client.get(PEOPLE, params={**WEEK, "timezone": "Asia/Singapore"})
    executions = await client.get(
        EXECUTIONS, params={**WEEK, "until": "2999-01-01T00:00:00Z", "sort": "cycle"}
    )

    assert people.status_code == 200, people.text
    assert people.json() == {"bucket": "day", "items": []}
    assert executions.status_code == 200, executions.text
    assert executions.json() == {
        "items": [],
        "nextCursor": None,
        "total": 0,
        "flagged": 0,
        "thresholds": {
            "retryAtLeast": 3,
            "stuckHours": 1,
            "spendTimes": 3,
            "taskConversations": 3,
            "spendTokens": None,
        },
    }


async def test_bad_overview_windows_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "root")

    missing = await client.get(OVERVIEW)
    inverted = await client.get(OVERVIEW, params={"since": WEEK["until"], "until": WEEK["since"]})
    too_long = await client.get(
        OVERVIEW, params={"since": "2025-01-01T00:00:00Z", "until": "2026-01-03T00:00:00Z"}
    )
    bad_zone = await client.get(OVERVIEW, params={**WEEK, "timezone": "Mars/Olympus"})

    assert missing.status_code == 422
    assert inverted.status_code == 422 and "since" in inverted.json()["detail"]
    assert too_long.status_code == 422 and "366" in too_long.json()["detail"]
    assert bad_zone.status_code == 422 and "timezone" in bad_zone.json()["detail"]


async def test_bad_people_windows_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    """按人与总览同一套时间窗规则。"""

    await login_as(client, pg_url, "root")

    missing = await client.get(PEOPLE)
    inverted = await client.get(PEOPLE, params={"since": WEEK["until"], "until": WEEK["since"]})
    too_long = await client.get(
        PEOPLE, params={"since": "2025-01-01T00:00:00Z", "until": "2026-01-03T00:00:00Z"}
    )
    bad_zone = await client.get(PEOPLE, params={**WEEK, "timezone": "Mars/Olympus"})

    assert missing.status_code == 422
    assert inverted.status_code == 422 and "since" in inverted.json()["detail"]
    assert too_long.status_code == 422 and "366" in too_long.json()["detail"]
    assert bad_zone.status_code == 422 and "timezone" in bad_zone.json()["detail"]


async def test_bad_execution_parameters_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    """游标只对发它的那种排序与方向有效：换了排序键或方向，与编坏的游标一样是 422。"""

    await login_as(client, pg_url, "root")
    tokens_cursor = encode_execution_cursor(
        ExecutionCursor(sort="tokens", order="desc", value=10, conversation_id=uuid.uuid4())
    )
    start_cursor = encode_execution_cursor(
        ExecutionCursor(
            sort="start",
            order="desc",
            value=datetime(2026, 9, 2, tzinfo=UTC),
            conversation_id=uuid.uuid4(),
        )
    )

    missing = await client.get(EXECUTIONS)
    inverted = await client.get(EXECUTIONS, params={"since": WEEK["until"], "until": WEEK["since"]})
    bad_sort = await client.get(EXECUTIONS, params={**WEEK, "sort": "sideways"})
    bad_limit = await client.get(EXECUTIONS, params={**WEEK, "limit": 0})
    garbage = await client.get(EXECUTIONS, params={**WEEK, "cursor": "not-a-cursor"})
    other_sort = await client.get(
        EXECUTIONS, params={**WEEK, "sort": "start", "cursor": tokens_cursor}
    )
    other_order = await client.get(
        EXECUTIONS, params={**WEEK, "order": "asc", "cursor": start_cursor}
    )
    matching = await client.get(EXECUTIONS, params={**WEEK, "cursor": start_cursor})

    assert missing.status_code == 422
    assert inverted.status_code == 422 and "since" in inverted.json()["detail"]
    assert bad_sort.status_code == 422
    assert bad_limit.status_code == 422
    for response in (garbage, other_sort, other_order):
        assert response.status_code == 422 and "cursor" in response.json()["detail"]
    assert matching.status_code == 200, matching.text
