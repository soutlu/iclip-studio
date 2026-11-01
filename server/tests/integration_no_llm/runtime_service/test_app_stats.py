"""运行时服务的统计接口：只答调用方应用的会话；按时间窗（各行自己的时刻，左闭右开）或按会话取，二选一；
运行只算运行驱动登记过、开始与终态都有的顶层运行；会话的首末消息按发起时刻，同一时刻按 ``prompt_id``。

应用 A 是 ``reader``（``app_client``），应用 B 是 ``bff``。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from agent_runtime.app_wire import MAX_STATS_SESSIONS
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from tests.helpers.audit import Plant

BASE = datetime.now(UTC).replace(microsecond=0)


def ago(**delta: float) -> datetime:
    return BASE - timedelta(**delta)


def iso(moment: datetime) -> str:
    return moment.isoformat()


def moment(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


async def open_session(conn: AsyncConnection, app_id: str) -> uuid.UUID:
    session_id = uuid.uuid4()
    await conn.execute(
        text("INSERT INTO agent_runtime.sessions (id, app_id) VALUES (:id, :app_id)"),
        {"id": session_id, "app_id": app_id},
    )
    return session_id


async def post(
    client: httpx.AsyncClient, path: str, body: Mapping[str, object]
) -> list[dict[str, Any]]:
    response = await client.post(path, json=body)
    assert response.status_code == 200, response.text
    return response.json()["items"]


async def test_stats_answer_only_the_calling_apps_sessions(
    engine: AsyncEngine, app_client: httpx.AsyncClient
) -> None:
    async with engine.begin() as conn:
        plant = Plant(conn)
        mine, theirs = await open_session(conn, "reader"), await open_session(conn, "bff")
        for session_id in (mine, theirs):
            prompt = await plant.prompt(session_id, user_name="Sara.Hong", at=ago(hours=2))
            await plant.run(prompt, started_at=ago(hours=2), ended_at=ago(hours=1))
            await plant.usage(session_id, tokens=10, last_at=ago(hours=1))
        # 没开会话的对话 id：哪个应用都不认。
        stray = uuid.uuid4()
        await plant.prompt(stray, user_name="Sara.Hong", at=ago(hours=2))

    window = {"since": iso(ago(days=1))}
    both = {"session_ids": [str(mine), str(theirs), str(stray)]}
    for path in ("/stats/prompts", "/stats/runs", "/stats/usage"):
        assert {row["session_id"] for row in await post(app_client, path, window)} == {str(mine)}
        assert {row["session_id"] for row in await post(app_client, path, both)} == {str(mine)}
    sessions = await post(app_client, "/stats/sessions", both)
    assert [row["session_id"] for row in sessions] == [str(mine)]


async def test_stats_leave_out_preview_sessions(
    engine: AsyncEngine, admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    """预览会话（试 agent 草稿或某一版用的）不是应用的对话，四个统计接口都不算它。"""

    created = await admin.post("/agents", json={"id": "tester", "name": "测试"})
    assert created.status_code == 201, created.text
    async with engine.begin() as conn:
        plant = Plant(conn)
        normal = await open_session(conn, "reader")
        preview = uuid.uuid4()
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.sessions (id, app_id, preview_agent_id)"
                " VALUES (:id, 'reader', 'tester')"
            ),
            {"id": preview},
        )
        for session_id in (normal, preview):
            prompt = await plant.prompt(session_id, user_name="Sara.Hong", at=ago(hours=2))
            await plant.run(prompt, started_at=ago(hours=2), ended_at=ago(hours=1))
            await plant.usage(session_id, tokens=10, last_at=ago(hours=1))

    window = {"since": iso(ago(days=1))}
    both = {"session_ids": [str(normal), str(preview)]}
    for path in ("/stats/prompts", "/stats/runs", "/stats/usage"):
        assert {row["session_id"] for row in await post(app_client, path, window)} == {
            str(normal)
        }, path
        assert {row["session_id"] for row in await post(app_client, path, both)} == {str(normal)}, (
            path
        )
    sessions = await post(app_client, "/stats/sessions", both)
    assert [row["session_id"] for row in sessions] == [str(normal)]


async def test_window_falls_on_each_rows_own_time_and_sessions_take_everything(
    engine: AsyncEngine, app_client: httpx.AsyncClient
) -> None:
    """消息看发起时刻，运行看开始事件（不看登记时刻），用量看最后一次累加；窗口左闭右开。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        session_id = await open_session(conn, "reader")
        early = await plant.prompt(session_id, user_name="Sara.Hong", at=ago(hours=5))
        await plant.run(early, started_at=ago(hours=5), ended_at=ago(hours=4))
        at_since = await plant.prompt(session_id, user_name="Derek.Lam", at=ago(hours=3))
        await plant.run(at_since, started_at=ago(hours=3), ended_at=ago(hours=2))
        await plant.prompt(session_id, user_name="Eva.Lin", at=ago(hours=1))
        await plant.usage(session_id, tokens=10, last_at=ago(hours=3), model="m-a")
        await plant.usage(session_id, tokens=20, last_at=ago(hours=1), model="m-b")
        # 登记时刻与开始事件错开：窗外开始的那次登记在窗内，窗内开始的那次登记在窗外。
        for prompt_id, registered in ((early, ago(hours=2)), (at_since, ago(hours=6))):
            await conn.execute(
                text(
                    "UPDATE agent_runtime.agent_job_runs SET started_at = :at"
                    " WHERE prompt_id = :prompt_id"
                ),
                {"at": registered, "prompt_id": prompt_id},
            )

    window = {"since": iso(ago(hours=3)), "until": iso(ago(hours=1))}
    prompts = await post(app_client, "/stats/prompts", window)
    runs = await post(app_client, "/stats/runs", window)
    usage = await post(app_client, "/stats/usage", window)

    assert [(row["prompt_id"], row["user_name"]) for row in prompts] == [(at_since, "Derek.Lam")]
    assert [
        (row["user_name"], moment(row["started_at"]), moment(row["ended_at"])) for row in runs
    ] == [("Derek.Lam", ago(hours=3), ago(hours=2))]
    assert [(row["model_name"], row["input_tokens"]) for row in usage] == [("m-a", 10)]

    everything = {"session_ids": [str(session_id)]}
    assert len(await post(app_client, "/stats/prompts", everything)) == 3
    assert len(await post(app_client, "/stats/runs", everything)) == 2
    assert [row["model_name"] for row in await post(app_client, "/stats/usage", everything)] == [
        "m-a",
        "m-b",
    ]


async def test_runs_in_a_window_keep_their_whole_history_outside_it(
    engine: AsyncEngine, app_client: httpx.AsyncClient
) -> None:
    """窗口只圈开始事件：窗内开始、窗后才结束的照算，结束取窗外那条；窗前开始、窗内结束的不算；
    窗前已有一条开始事件、窗内又补了一条的，第一条开始在窗外，也不算。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        session_id = await open_session(conn, "reader")
        prompt = await plant.prompt(session_id, user_name="Sara.Hong", at=ago(hours=8))
        await plant.run(prompt, started_at=ago(hours=8), ended_at=ago(hours=4))
        await plant.run(prompt, started_at=ago(hours=3), ended_at=ago(minutes=30))
        await plant.run(prompt, started_at=ago(hours=7), ended_at=ago(hours=6))
        restarted = (
            await conn.execute(
                text(
                    "SELECT r.run_id FROM agent_runtime.agent_job_runs r"
                    " JOIN agent_runtime.events e ON e.run_id = r.run_id"
                    " WHERE r.prompt_id = :prompt_id AND e.kind = 'run_started'"
                    " AND e.timestamp = :at"
                ),
                {"prompt_id": prompt, "at": ago(hours=7)},
            )
        ).scalar_one()
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.events (run_id, kind, step_index, timestamp, metadata)"
                " VALUES (:run_id, 'run_started', 1, :at, '{}')"
            ),
            {"run_id": restarted, "at": ago(hours=2)},
        )

    runs = await post(
        app_client, "/stats/runs", {"since": iso(ago(hours=5)), "until": iso(ago(hours=1))}
    )

    assert [(moment(row["started_at"]), moment(row["ended_at"])) for row in runs] == [
        (ago(hours=3), ago(minutes=30))
    ]


async def test_runs_are_registered_top_level_runs_that_reached_an_end(
    engine: AsyncEngine, app_client: httpx.AsyncClient
) -> None:
    """跑完与失败的各算一次，结束取第一条终态；没有终态的不算；没登记的运行（子代理的内部运行）不算。"""

    async with engine.begin() as conn:
        plant = Plant(conn)
        session_id = await open_session(conn, "reader")
        prompt = await plant.prompt(session_id, user_name="Sara.Hong", at=ago(hours=6))
        await plant.run(prompt, started_at=ago(hours=6), ended_at=ago(hours=5))
        await plant.run(prompt, started_at=ago(hours=4), ended_at=ago(hours=3), end="run_failed")
        await plant.run(prompt, started_at=ago(hours=2), ended_at=None)
        for kind, at in (("run_started", ago(hours=6)), ("run_completed", ago(hours=1))):
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.events (run_id, kind, step_index, timestamp,"
                    " conversation_id, parent_run_id, metadata)"
                    " VALUES ('sub-1', :kind, 0, :at, :conversation_id, 'agent-parent', '{}')"
                ),
                {"kind": kind, "at": at, "conversation_id": str(session_id)},
            )
        # 同一次运行后来又补了一条终态：结束仍是第一条。
        first = (
            await conn.execute(
                text(
                    "SELECT run_id FROM agent_runtime.agent_job_runs WHERE prompt_id = :prompt_id"
                    " ORDER BY started_at LIMIT 1"
                ),
                {"prompt_id": prompt},
            )
        ).scalar_one()
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.events (run_id, kind, step_index, timestamp, metadata)"
                " VALUES (:run_id, 'run_failed', 1, :at, '{}')"
            ),
            {"run_id": first, "at": ago(minutes=10)},
        )

    runs = await post(app_client, "/stats/runs", {"session_ids": [str(session_id)]})

    assert [(moment(row["started_at"]), moment(row["ended_at"])) for row in runs] == [
        (ago(hours=6), ago(hours=5)),
        (ago(hours=4), ago(hours=3)),
    ]


async def test_session_summary_is_the_first_prompt_and_the_latest_prompts_user(
    engine: AsyncEngine, app_client: httpx.AsyncClient
) -> None:
    async with engine.begin() as conn:
        plant = Plant(conn)
        ran, tied, idle = [await open_session(conn, "reader") for _ in range(3)]
        await plant.prompt(ran, user_name="Sara.Hong", at=ago(hours=3))
        await plant.prompt(ran, user_name="Derek.Lam", at=ago(hours=1))
        for prompt_id, name in (("prm_a", "Sara.Hong"), ("prm_b", "Eva.Lin")):
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.agent_jobs (prompt_id, conversation_id, agent_id,"
                    " owner_user_id, user_name, content, status, created_at)"
                    " VALUES (:prompt_id, :session_id, 'agent', :owner, :name, '', 'done', :at)"
                ),
                {
                    "prompt_id": prompt_id,
                    "session_id": str(tied),
                    "owner": uuid.uuid4(),
                    "name": name,
                    "at": ago(hours=2),
                },
            )

    rows = await post(
        app_client, "/stats/sessions", {"session_ids": [str(ran), str(tied), str(idle)]}
    )

    found = {
        row["session_id"]: (moment(row["first_prompt_at"]), row["latest_user_name"]) for row in rows
    }
    assert found == {
        str(ran): (ago(hours=3), "Derek.Lam"),
        str(tied): (ago(hours=2), "Eva.Lin"),
    }


async def test_a_query_takes_exactly_one_bounded_mode(app_client: httpx.AsyncClient) -> None:
    one = str(uuid.uuid4())
    too_many = [str(uuid.uuid4()) for _ in range(MAX_STATS_SESSIONS + 1)]
    bad_queries: list[dict[str, object]] = [
        {},
        {"until": iso(BASE)},
        {"since": iso(ago(days=1)), "session_ids": [one]},
        {"session_ids": []},
        {"session_ids": too_many},
    ]
    for path in ("/stats/prompts", "/stats/runs", "/stats/usage"):
        for body in bad_queries:
            assert (await app_client.post(path, json=body)).status_code == 422, (path, body)
    for body in ({}, {"session_ids": []}, {"session_ids": too_many}):
        assert (await app_client.post("/stats/sessions", json=body)).status_code == 422
