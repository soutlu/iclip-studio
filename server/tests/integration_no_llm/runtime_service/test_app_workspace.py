"""运行时服务的会话工作区与素材台账：按「属主/会话」读写，带版本写对不上 409，别人的命名空间看不到；
分叉与按清单拷文件把文件和整份素材台账拷进目标属主的会话，挡下来时报错同后端。"""

from __future__ import annotations

import uuid

import httpx
import pytest
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.references import plant_user
from tests.helpers.runtime import says
from tests.helpers.runtime_service import add_model, connect_provider, publish_agent, settled

AGENT = "director"
IMAGE = "https://bkt.oss-ap-southeast-1.aliyuncs.com/style.jpg"


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says("答：第一问")}


@pytest.fixture
async def session(admin: httpx.AsyncClient, app_client: httpx.AsyncClient) -> str:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)
    session_id = str(uuid.uuid4())
    opened = await app_client.post("/sessions", json={"id": session_id, "agent_id": AGENT})
    assert opened.status_code == 204, opened.text
    return session_id


@pytest.fixture
async def other(engine: AsyncEngine) -> uuid.UUID:
    return await plant_user(engine, "other-owner")


def as_owner(owner: uuid.UUID) -> dict[str, str]:
    return {"X-End-User": str(owner)}


async def test_files_are_read_and_written_with_versions(
    app_client: httpx.AsyncClient, other: uuid.UUID
) -> None:
    session = str(uuid.uuid4())
    base = f"/sessions/{session}/files"

    assert (await app_client.get(base)).json() == {"files": []}
    created = await app_client.put(f"{base}/notes/brief.md", json={"content": "第一版"})
    assert created.status_code == 200, created.text
    assert (created.json()["path"], created.json()["version"]) == ("notes/brief.md", 1)
    await app_client.put(f"{base}/film.icml", json={"content": "工程"})

    read = await app_client.get(f"{base}/notes/brief.md")
    assert read.json() == {"path": "notes/brief.md", "content": "第一版", "version": 1}

    stale = await app_client.put(
        f"{base}/notes/brief.md", json={"content": "第二版", "expected_version": 5}
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == "notes/brief.md 已经被改过：期望版本 5，实际 1"
    fresh = await app_client.put(
        f"{base}/notes/brief.md", json={"content": "第二版", "expected_version": 1}
    )
    assert fresh.json()["version"] == 2

    listed = await app_client.get(base)
    assert sorted(entry["path"] for entry in listed.json()["files"]) == [
        "film.icml",
        "notes/brief.md",
    ]
    narrowed = await app_client.get(base, params={"prefix": "notes"})
    assert [entry["path"] for entry in narrowed.json()["files"]] == ["notes/brief.md"]
    not_a_path = await app_client.get(base, params={"prefix": "notes/"})
    assert not_a_path.status_code == 422

    missing = await app_client.get(f"{base}/nothing.md")
    assert missing.status_code == 404
    assert missing.json()["detail"] == "这段对话里没有这个文件"
    # 命名空间按属主分：同一个会话 id 换个属主就是另一块空间。
    elsewhere = await app_client.get(f"{base}/notes/brief.md", headers=as_owner(other))
    assert elsewhere.status_code == 404


async def test_materials_are_recorded_and_looked_up(
    app_client: httpx.AsyncClient, other: uuid.UUID
) -> None:
    session = str(uuid.uuid4())
    base = f"/sessions/{session}/materials"

    recorded = await app_client.post(base, json={"materials": [{"url": IMAGE, "kind": "image"}]})
    assert recorded.status_code == 204, recorded.text
    # 同一地址再登记保留首条。
    await app_client.post(base, json={"materials": [{"url": IMAGE, "kind": "video"}]})

    found = await app_client.get(base, params={"url": IMAGE})
    assert found.json() == {"url": IMAGE, "kind": "image"}
    unknown = await app_client.get(base, params={"url": "https://cdn.test/x.png"})
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "这段对话的素材里没有这个地址"
    elsewhere = await app_client.get(base, params={"url": IMAGE}, headers=as_owner(other))
    assert elsewhere.status_code == 404


async def test_a_fork_copies_files_materials_and_history_to_the_target_owner(
    running: None,
    app_client: httpx.AsyncClient,
    session: str,
    owner: uuid.UUID,
    other: uuid.UUID,
) -> None:
    target = str(uuid.uuid4())
    fork_body = {"target_id": target, "source_user": str(owner), "turn": 1}

    never_ran = await app_client.post(f"/sessions/{session}:fork", json=fork_body)
    assert never_ran.status_code == 422
    assert never_ran.json()["detail"] == "这段对话还没跑过，没有可分叉的轮次"

    await app_client.put(f"/sessions/{session}/files/brief.md", json={"content": "要点"})
    sent = await app_client.post(
        f"/sessions/{session}/prompts",
        json={
            "prompt_id": "prm_first",
            "content": [
                {"type": "text", "text": "第一问"},
                {"type": "image", "source": {"kind": "url", "url": IMAGE}},
            ],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    await settled(app_client, session)

    too_far = await app_client.post(f"/sessions/{session}:fork", json={**fork_body, "turn": 2})
    assert too_far.status_code == 422
    assert too_far.json()["detail"] == "这段对话只有 1 轮，分不出第 2 轮"

    forked = await app_client.post(
        f"/sessions/{session}:fork", json=fork_body, headers=as_owner(other)
    )
    assert forked.status_code == 204, forked.text

    copied = await app_client.get(f"/sessions/{target}/files/brief.md", headers=as_owner(other))
    assert copied.json()["content"] == "要点"
    material = await app_client.get(
        f"/sessions/{target}/materials", params={"url": IMAGE}, headers=as_owner(other)
    )
    assert material.json() == {"url": IMAGE, "kind": "image"}
    page = await app_client.get(f"/sessions/{target}/transcript", params={"session_agent": AGENT})
    assert [turn["turnId"] for turn in page.json()["items"]] == ["t1"]


async def test_files_copy_needs_one_of_the_required_files(
    app_client: httpx.AsyncClient, owner: uuid.UUID, other: uuid.UUID
) -> None:
    source = str(uuid.uuid4())
    target = str(uuid.uuid4())
    await app_client.put(f"/sessions/{source}/files/film.icml", json={"content": "工程"})
    await app_client.put(f"/sessions/{source}/files/treatment.md", json={"content": "方案"})
    await app_client.post(
        f"/sessions/{source}/materials", json={"materials": [{"url": IMAGE, "kind": "image"}]}
    )
    files = [["film.icml", "old_film.icml"], ["treatment.md", "treatment.md"], ["gone.md", "x.md"]]

    nothing = await app_client.post(
        f"/sessions/{source}/files:copy",
        json={
            "target_id": target,
            "source_user": str(owner),
            "files": files,
            "require_any": ["video_shot.json"],
        },
        headers=as_owner(other),
    )
    assert nothing.json() == {"copied": False}
    assert (await app_client.get(f"/sessions/{target}/files", headers=as_owner(other))).json() == {
        "files": []
    }

    copied = await app_client.post(
        f"/sessions/{source}/files:copy",
        json={
            "target_id": target,
            "source_user": str(owner),
            "files": files,
            "require_any": ["film.icml"],
        },
        headers=as_owner(other),
    )
    assert copied.json() == {"copied": True}
    listed = await app_client.get(f"/sessions/{target}/files", headers=as_owner(other))
    assert sorted(entry["path"] for entry in listed.json()["files"]) == [
        "old_film.icml",
        "treatment.md",
    ]
    material = await app_client.get(
        f"/sessions/{target}/materials", params={"url": IMAGE}, headers=as_owner(other)
    )
    assert material.status_code == 200
