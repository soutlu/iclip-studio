"""运行时服务的预览会话：开的时候不看上不上菜单、发没发布过；草稿预览每次运行装 agent 当下的草稿，版本预览装
那一版；只跑它预览的 agent；开了以后是不是预览不再变；不能分叉、不能拷文件进出；运行开始、轮次开始与开跑检查的
回调与事件流上的活动都标着 ``preview``。

``app_client`` 是被测应用 ``reader``；``admin`` 经管理接口种 agent。"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from agent_runtime.settings import ResolvedHooks
from pydantic_ai.models import Model

from tests.helpers.runtime import says
from tests.helpers.runtime_service import (
    PROVIDER,
    READER_HOOKS,
    HookRecorder,
    LiveRuntime,
    add_model,
    connect_provider,
    publish_agent,
    receive,
    settled,
)

AGENT = "tester"
OTHER_AGENT = "helper"
VERSION_MODEL = "m-version"
DRAFT_MODEL = "m-draft"
EDITED_MODEL = "m-edited"


@pytest.fixture
def models() -> dict[str, Model]:
    return {
        VERSION_MODEL: says("版本的答复"),
        DRAFT_MODEL: says("草稿的答复"),
        EDITED_MODEL: says("改过的草稿的答复"),
    }


async def save_draft(admin: httpx.AsyncClient, agent_id: str, model: str) -> None:
    """把草稿的模型换成 ``model``，别的不动。"""

    detail = (await admin.get(f"/agents/{agent_id}")).json()
    saved = await admin.put(
        f"/agents/{agent_id}/draft",
        json={
            "config": {
                "schema_version": 1,
                "instructions": "",
                "model": {"provider": PROVIDER, "name": model},
                "tools": [],
                "subagents": [],
            },
            "skillIds": [],
            "lockVersion": detail["draft"]["lockVersion"],
        },
    )
    assert saved.status_code == 200, saved.text


@pytest.fixture
async def seeded(admin: httpx.AsyncClient) -> str:
    """``tester`` 发布了 v1（版本模型），不上首页菜单，草稿已改成草稿模型、没有发布；另有一个 ``helper``。
    交回 ``tester`` 的 v1 的 id。"""

    provider_id = await connect_provider(admin)
    for name in (VERSION_MODEL, DRAFT_MODEL, EDITED_MODEL):
        await add_model(admin, provider_id, name)
    await publish_agent(admin, AGENT, model=VERSION_MODEL, listed=False)
    await publish_agent(admin, OTHER_AGENT, model=VERSION_MODEL, listed=False)
    await save_draft(admin, AGENT, DRAFT_MODEL)
    return str((await admin.get(f"/agents/{AGENT}")).json()["activeVersion"]["id"])


async def open_preview(
    client: httpx.AsyncClient, agent_id: str = AGENT, version_id: str | None = None
) -> httpx.Response:
    return await client.post(
        "/sessions",
        json={"id": str(uuid.uuid4()), "preview": {"agent_id": agent_id, "version_id": version_id}},
    )


async def preview_of(client: httpx.AsyncClient, version_id: str | None = None) -> str:
    session_id = str(uuid.uuid4())
    opened = await client.post(
        "/sessions",
        json={"id": session_id, "preview": {"agent_id": AGENT, "version_id": version_id}},
    )
    assert opened.status_code == 204, opened.text
    return session_id


def prompt(prompt_id: str, agent_id: str = AGENT) -> dict[str, Any]:
    return {
        "prompt_id": prompt_id,
        "content": [{"type": "text", "text": "试一下"}],
        "user_name": "logan",
        "agent_id": agent_id,
    }


async def reply_after(client: httpx.AsyncClient, session_id: str, prompt_id: str) -> str:
    """发一条消息、等它跑完，交回这一页 transcript 的原文。"""

    sent = await client.post(f"/sessions/{session_id}/prompts", json=prompt(prompt_id))
    assert sent.status_code == 200, sent.text
    await settled(client, session_id)
    page = await client.get(f"/sessions/{session_id}/transcript", params={"session_agent": AGENT})
    assert page.status_code == 200, page.text
    return page.text


async def test_a_draft_preview_runs_the_draft_of_the_moment_and_a_version_preview_its_version(
    running: None, seeded: str, admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    draft = await preview_of(app_client)
    pinned = await preview_of(app_client, seeded)

    assert "草稿的答复" in await reply_after(app_client, draft, "prm_draft_1")
    assert "版本的答复" in await reply_after(app_client, pinned, "prm_pinned_1")

    # 改了草稿：草稿预览下一次运行就换成新草稿，版本预览不变。
    await save_draft(admin, AGENT, EDITED_MODEL)
    assert "改过的草稿的答复" in await reply_after(app_client, draft, "prm_draft_2")
    assert "改过的草稿的答复" not in await reply_after(app_client, pinned, "prm_pinned_2")


async def test_a_preview_needs_an_existing_agent_and_one_of_its_versions(
    seeded: str, admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    helper_version = (await admin.get(f"/agents/{OTHER_AGENT}")).json()["activeVersion"]["id"]

    missing = await open_preview(app_client, "nobody")
    foreign = await open_preview(app_client, AGENT, helper_version)
    both = await app_client.post(
        "/sessions",
        json={"id": str(uuid.uuid4()), "agent_id": AGENT, "preview": {"agent_id": AGENT}},
    )
    neither = await app_client.post("/sessions", json={"id": str(uuid.uuid4())})
    # 同一个不上菜单的 agent，开普通会话照旧不行。
    plain = await app_client.post("/sessions", json={"id": str(uuid.uuid4()), "agent_id": AGENT})

    assert (missing.status_code, missing.json()) == (404, {"detail": "没有标识为 nobody 的 agent"})
    assert (foreign.status_code, foreign.json()) == (422, {"detail": "这个版本不是 tester 的"})
    assert (both.status_code, neither.status_code) == (422, 422)
    assert plain.status_code == 422


async def test_a_preview_runs_only_the_agent_it_previews(
    seeded: str, app_client: httpx.AsyncClient
) -> None:
    session_id = await preview_of(app_client)

    sent = await app_client.post(
        f"/sessions/{session_id}/prompts", json=prompt("prm_other", OTHER_AGENT)
    )

    assert (sent.status_code, sent.json()) == (422, {"detail": "这段预览只能跑 tester"})


@pytest.fixture
async def director(admin: httpx.AsyncClient, seeded: str) -> None:
    """上了首页菜单的 ``director``，开普通会话用。"""

    await publish_agent(admin, "director", model=VERSION_MODEL)


async def open_plain(app_client: httpx.AsyncClient) -> str:
    session_id = str(uuid.uuid4())
    opened = await app_client.post("/sessions", json={"id": session_id, "agent_id": "director"})
    assert opened.status_code == 204, opened.text
    return session_id


@pytest.mark.usefixtures("director")
async def test_whether_a_session_is_a_preview_never_changes(
    seeded: str, app_client: httpx.AsyncClient
) -> None:
    preview = await preview_of(app_client)
    plain = await open_plain(app_client)

    as_plain = await app_client.post("/sessions", json={"id": preview, "agent_id": "director"})
    as_preview = await app_client.post(
        "/sessions", json={"id": plain, "preview": {"agent_id": AGENT}}
    )
    as_other_preview = await app_client.post(
        "/sessions", json={"id": preview, "preview": {"agent_id": OTHER_AGENT}}
    )
    reopened = await app_client.post(
        "/sessions", json={"id": preview, "preview": {"agent_id": AGENT, "version_id": seeded}}
    )

    taken = {"detail": "这个会话 id 已经被用了，换一个"}
    assert (as_plain.status_code, as_plain.json()) == (409, taken)
    assert (as_preview.status_code, as_preview.json()) == (409, taken)
    assert (as_other_preview.status_code, as_other_preview.json()) == (409, taken)
    assert reopened.status_code == 204, reopened.text


@pytest.mark.usefixtures("director")
async def test_a_preview_cannot_be_forked_or_copied_into_or_out_of(
    app_client: httpx.AsyncClient, owner: uuid.UUID
) -> None:
    preview = await preview_of(app_client)
    plain = await open_plain(app_client)
    copy = {"source_user": str(owner), "files": [["brief.md", "brief.md"]]}

    forked = await app_client.post(
        f"/sessions/{preview}:fork",
        json={"target_id": str(uuid.uuid4()), "source_user": str(owner), "turn": 1},
    )
    copied_out = await app_client.post(
        f"/sessions/{preview}/files:copy", json={**copy, "target_id": plain}
    )
    copied_in = await app_client.post(
        f"/sessions/{plain}/files:copy", json={**copy, "target_id": preview}
    )

    refused = {"detail": "预览会话不能分叉，也不能拷文件进出"}
    for answer in (forked, copied_out, copied_in):
        assert (answer.status_code, answer.json()) == (422, refused)


# --- 回调与事件流：标着 preview ---------------------------------------------------


@pytest.fixture
def reader_hooks() -> ResolvedHooks | None:
    return READER_HOOKS


class TestFlags:
    @pytest.fixture
    def models(self) -> dict[str, Model]:
        return {"test-model": says("好")}

    def test_hooks_and_activity_events_of_a_preview_say_preview(
        self, live: LiveRuntime, hook_recorder: HookRecorder
    ) -> None:
        preview = str(uuid.uuid4())
        opened = live.tc.post(
            "/v1/sessions",
            json={"id": preview, "preview": {"agent_id": live.agent}},
            headers=live.headers(),
        )
        assert opened.status_code == 204, opened.text
        plain = live.open_session()

        with live.connect("/v1/events") as events:
            live.send(preview, "prm_preview")
            live.settled(preview)
            first = receive(events, "event.session.work_changed")
            live.send(plain, "prm_plain")
            live.settled(plain)
            hook_recorder.waits_for("turn-started", 2)
            frames = [first]
            while frames[-1]["session_id"] != plain:
                frames.append(receive(events, "event.session.work_changed"))

        assert {(frame["session_id"], frame["preview"]) for frame in frames} == {
            (preview, True),
            (plain, False),
        }
        for hook in ("gate", "run-started", "turn-started"):
            assert [
                (body["session_id"], body["preview"]) for body in hook_recorder.named(hook)
            ] == [
                (preview, True),
                (plain, False),
            ], hook
