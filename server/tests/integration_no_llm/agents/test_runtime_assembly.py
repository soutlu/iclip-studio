from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest
from cue.assembly.config_services import ConfigServices
from cue.config.agent_config.schemas import AgentCreateIn, AgentDraftIn, AgentUpdateIn
from cue.config.model_providers.schemas import (
    CredentialUpdateIn,
    CustomModelCreateIn,
    DefaultModelIn,
    ModelUpdateIn,
)
from cue.config.skills.schemas import DraftFileWriteIn, SkillPublishIn, SkillUpdateIn
from cue.errors import AgentUnavailable
from cue.harness.step_store_pg import PgStepStore
from cue.harness.transcript.store import TranscriptStore
from fastapi import FastAPI
from pydantic_ai.capabilities import Capability
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.schemas import DEFAULT_TITLE
from tests.helpers.agents import (
    AgentSeed,
    Seeded,
    SkillSeed,
    SubagentSeed,
    agent_config,
    model_builder,
    save_and_publish,
    seed_agents,
)
from tests.helpers.app import TEST_MODEL_NAME, make_client, make_runtime_config, settled
from tests.helpers.auth import login_as_editor
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected
from tests.helpers.plugins import FixedPlugin
from tests.helpers.runtime import (
    AGENT_ID,
    drained,
    make_runner,
    new_conversation_id,
    submit_text,
)
from tests.helpers.runtime_backed import build_backed_app, config_services_of, runtime_of

OTHER_MODEL = "other-model"
TITLE_MODEL = "title-model"
SKILL = "storyboard-rules"


@pytest.fixture
def heard() -> list[tuple[str, str]]:
    return []


def _recording(name: str, heard: list[tuple[str, str]]) -> FunctionModel:
    async def stream(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        heard.append((name, info.instructions or ""))
        yield "好的"

    def answer(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart("分镜脚本")])

    return FunctionModel(answer, stream_function=stream, model_name=name)


@pytest.fixture
def models(heard: list[tuple[str, str]]) -> Mapping[str, Model]:
    return {name: _recording(name, heard) for name in (TEST_MODEL_NAME, OTHER_MODEL, TITLE_MODEL)}


def services_of(app: FastAPI) -> ConfigServices:
    return config_services_of(app)


async def open_conversation(client: httpx.AsyncClient, agent_id: str = AGENT_ID) -> str:
    opened = await client.post("/conversations", json={"agentId": agent_id})
    assert opened.status_code == 201, opened.text
    return str(opened.json()["conversation"]["id"])


async def send(
    client: httpx.AsyncClient, conversation_id: str, words: str = "开始"
) -> httpx.Response:
    return await client.post(
        f"/conversations/{conversation_id}/prompts",
        json={
            "prompt_id": f"prm_{uuid.uuid4().hex[:8]}",
            "content": [{"type": "text", "text": words}],
        },
    )


async def run_once(client: httpx.AsyncClient, conversation_id: str) -> None:
    sent = await send(client, conversation_id)
    assert sent.status_code == 200, sent.text
    await settled(client, conversation_id)


async def run_metadata(pg_url: str, conversation_id: str) -> list[dict[str, str]]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT metadata FROM agent_runtime.runs"
                " WHERE conversation_id = :cid AND parent_run_id IS NULL ORDER BY started_at"
            ),
            {"cid": conversation_id},
        )
        return [json.loads(row[0]) for row in rows]


async def session_version(pg_url: str, conversation_id: str) -> uuid.UUID | None:
    async with connected(pg_url) as conn:
        return (
            await conn.execute(
                text("SELECT agent_version_id FROM agent_runtime.sessions WHERE id = :id"),
                {"id": conversation_id},
            )
        ).scalar_one_or_none()


async def seed(
    app: FastAPI, engine: AsyncEngine, *seeds: AgentSeed, models: tuple[str, ...] = ()
) -> Seeded:
    seeded = await seed_agents(services_of(app), engine, seeds)
    for name in models:
        await services_of(app).model_providers.add_model(
            seeded.provider_id, CustomModelCreateIn(name=name, type="llm", api="chat")
        )
    return seeded


async def title_of(client: httpx.AsyncClient, conversation_id: str, *, expect: str) -> str:
    title = ""
    for _ in range(100):
        title = (await client.get(f"/conversations/{conversation_id}")).json()["conversation"][
            "title"
        ]
        if title == expect:
            return title
        await asyncio.sleep(0.02)
    return title


async def republish(app: FastAPI, seeded: Seeded, seed_: AgentSeed) -> uuid.UUID:
    services = services_of(app)
    skill_ids = [seeded.skills[skill.name] for skill in seed_.skills]
    version = await save_and_publish(
        services, seeded, seed_.agent_id, agent_config(seed_), skill_ids
    )
    seeded.versions[seed_.agent_id] = version
    return version


async def test_a_conversation_keeps_its_version_after_a_new_one_is_published(
    app: FastAPI, engine: AsyncEngine, pg_url: str, heard: list[tuple[str, str]]
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID, instructions="第一版提示词"))
    v1 = seeded.versions[AGENT_ID]
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        old = await open_conversation(client)
        v2 = await republish(app, seeded, AgentSeed(AGENT_ID, instructions="第二版提示词"))
        new = await open_conversation(client)

        await run_once(client, old)
        await run_once(client, new)

    assert [words for _model, words in heard] == ["第一版提示词", "第二版提示词"]
    assert v1 != v2
    assert await session_version(pg_url, old) == v1
    assert await session_version(pg_url, new) == v2
    (old_run,) = await run_metadata(pg_url, old)
    (new_run,) = await run_metadata(pg_url, new)
    assert (old_run["agent_version_id"], new_run["agent_version_id"]) == (str(v1), str(v2))
    assert old_run["model"] == TEST_MODEL_NAME and old_run["agent_id"] == AGENT_ID


async def test_a_fork_keeps_the_source_version_unless_it_switches_agent(
    app: FastAPI, engine: AsyncEngine, pg_url: str
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID), AgentSeed("assistant"))
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        source = await open_conversation(client)
        await run_once(client, source)
        await republish(app, seeded, AgentSeed(AGENT_ID, instructions="新版"))

        same = await client.post(f"/conversations/{source}:fork", json={"turn": 1})
        switched = await client.post(
            f"/conversations/{source}:fork", json={"turn": 1, "agentId": "assistant"}
        )

    assert same.status_code == switched.status_code == 201, (same.text, switched.text)
    v1 = await session_version(pg_url, source)
    assert await session_version(pg_url, same.json()["conversation"]["id"]) == v1
    assert (
        await session_version(pg_url, switched.json()["conversation"]["id"])
        == seeded.versions["assistant"]
    )


async def test_a_conversation_without_a_session_is_unavailable(
    app: FastAPI, engine: AsyncEngine, pg_url: str
) -> None:
    await seed(app, engine, AgentSeed(AGENT_ID))
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await open_conversation(client)
        async with connected(pg_url) as conn:
            await conn.execute(
                text("UPDATE agent_runtime.sessions SET agent_version_id = NULL WHERE id = :id"),
                {"id": conversation_id},
            )
        sent = await send(client, conversation_id)
        page = await client.get(f"/conversations/{conversation_id}/transcript")

    assert sent.status_code == 409
    assert sent.json()["code"] == "agent_unavailable"
    assert page.status_code == 200, "读历史照常"


async def test_only_listed_published_active_agents_open_conversations_and_reach_the_home_list(
    app: FastAPI, engine: AsyncEngine, pg_url: str
) -> None:
    seeded = await seed(
        app,
        engine,
        AgentSeed("helper", listed=False),
        AgentSeed("director"),
        AgentSeed(AGENT_ID),
        AgentSeed("retired"),
    )
    services = services_of(app)
    await services.agent_config.archive("retired", by=seeded.author)
    await services.agent_config.create(
        AgentCreateIn(id="drafting", name="drafting"), by=seeded.author
    )
    await services.agent_config.update("drafting", AgentUpdateIn(listed=True))

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        home = (await client.get("/conversations/agents")).json()
        hidden = await client.post("/conversations", json={"agentId": "helper"})
        missing = await client.post("/conversations", json={"agentId": "nobody"})
        archived = await client.post("/conversations", json={"agentId": "retired"})
        unpublished = await client.post("/conversations", json={"agentId": "drafting"})

    assert [item["id"] for item in home["items"]] == ["director", AGENT_ID]
    assert home["default"] == "director"
    assert (hidden.status_code, missing.status_code) == (422, 422)
    assert (archived.status_code, unpublished.status_code) == (409, 409)
    assert "已归档" in archived.json()["detail"]


async def test_archiving_an_agent_keeps_its_existing_conversations_running(
    app: FastAPI, engine: AsyncEngine, pg_url: str, heard: list[tuple[str, str]]
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID, instructions="照旧"))
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await open_conversation(client)
        await services_of(app).agent_config.archive(AGENT_ID, by=seeded.author)
        refused = await client.post("/conversations", json={"agentId": AGENT_ID})
        await run_once(client, conversation_id)

    assert refused.status_code == 409
    assert heard == [(TEST_MODEL_NAME, "照旧")]


async def test_a_disabled_model_breaks_only_the_conversations_on_that_version(
    app: FastAPI, engine: AsyncEngine, pg_url: str, heard: list[tuple[str, str]]
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID), models=(OTHER_MODEL,))
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        old = await open_conversation(client)
        await republish(app, seeded, AgentSeed(AGENT_ID, model=OTHER_MODEL))
        new = await open_conversation(client)
        await services_of(app).model_providers.update_model(
            seeded.provider_id, "llm", TEST_MODEL_NAME, ModelUpdateIn(enabled=False)
        )

        broken = await send(client, old)
        await run_once(client, new)

    assert broken.status_code == 409
    assert broken.json()["code"] == "agent_unavailable"
    assert TEST_MODEL_NAME in broken.json()["detail"]
    assert heard == [(OTHER_MODEL, "")]


async def test_a_plugin_removed_from_the_code_makes_its_versions_unavailable(
    engine: AsyncEngine,
    pg_url: str,
    base_env: None,
    models: Mapping[str, Model],
    tmp_path: Path,
) -> None:
    def build(registry: dict[str, Any]) -> FastAPI:
        return build_backed_app(
            make_runtime_config(),
            engine=engine,
            skill_cache_dir=tmp_path / "skills",
            build_model=model_builder(models),
            credential_probe=KeyCheckingProbe({GOOD_KEY}),
            plugins=registry,
        )

    with_plugin = build(
        {"notes": FixedPlugin.bind(name="notes", capabilities=(Capability[Any](id="notes"),))}
    )
    await seed_agents(services_of(with_plugin), engine, (AgentSeed(AGENT_ID, plugins=("notes",)),))
    without = build({})

    async with make_client(with_plugin) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await open_conversation(client)
    async with make_client(without) as client:
        await client.post("/auth/login", data={"username": "logan", "password": "password-123"})
        refused = await send(client, conversation_id)

    assert refused.status_code == 409
    assert refused.json()["code"] == "agent_unavailable"
    assert "notes" in refused.json()["detail"]


async def test_a_run_that_cannot_assemble_after_queueing_fails_with_the_reason(
    engine: AsyncEngine,
) -> None:
    runner, _store, queue = make_runner(
        engine, agents={}, step_store=PgStepStore(engine), store=TranscriptStore()
    )
    conversation_id = new_conversation_id()
    prompt_id = await submit_text(runner, queue, conversation_id, "开始")
    await drained(queue, conversation_id)
    await runner.shutdown()

    async with engine.connect() as conn:
        status, reason = (
            await conn.execute(
                text(
                    "SELECT status, interrupt_reason FROM agent_runtime.agent_jobs"
                    " WHERE prompt_id = :id"
                ),
                {"id": prompt_id},
            )
        ).one()
    assert status == "failed"
    assert reason.startswith("agent_unavailable: ")


async def test_assemblies_are_reused_until_something_they_use_changes(
    app: FastAPI, engine: AsyncEngine, pg_url: str
) -> None:
    seeded = await seed(
        app,
        engine,
        AgentSeed("writer", listed=False),
        AgentSeed(
            AGENT_ID,
            skills=(SkillSeed(SKILL, references={"spec.md": "第一版"}),),
            subagents=(SubagentSeed("writer"),),
        ),
    )
    services = services_of(app)
    runtime = runtime_of(app)
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await open_conversation(client)

    async def agent() -> object:
        return (await runtime.for_conversation(conversation_id, AGENT_ID)).agent

    first = await agent()
    assert await agent() is first, "什么都没变"

    skill_id = seeded.skills[SKILL]
    current = await services.skills.read_file(skill_id, "references/spec.md")
    await services.skills.write_file(
        skill_id,
        "references/spec.md",
        DraftFileWriteIn(content="第二版", base_hash=current.hash),
        by=seeded.author,
    )
    await services.skills.publish(skill_id, SkillPublishIn(), by=seeded.author)
    after_skill = await agent()
    assert after_skill is not first

    providers = services.model_providers
    credential = (await providers.providers()).providers[0].credentials[0]
    await providers.update_credential(
        seeded.provider_id,
        credential.id,
        CredentialUpdateIn(fields={"base_url": "https://dashscope.test/v2"}),
    )
    after_key = await agent()
    assert after_key is not after_skill

    await providers.update_model(
        seeded.provider_id, "llm", TEST_MODEL_NAME, ModelUpdateIn(context_size=4096)
    )
    after_model = await runtime.for_conversation(conversation_id, AGENT_ID)
    assert after_model.agent is not after_key and after_model.context_window == 4096

    await services.agent_config.update("writer", AgentUpdateIn(description="写镜头"))
    after_description = await agent()
    assert after_description is not after_model.agent

    await republish(app, seeded, AgentSeed("writer", listed=False, instructions="新"))
    assert await agent() is not after_description
    assert await agent() is await agent()

    skill_hashes = {
        skill.name: skill.latest_content_hash for skill in await services.skills.catalog()
    }
    async with make_client(app) as client:
        await client.post("/auth/login", data={"username": "logan", "password": "password-123"})
        await run_once(client, conversation_id)
    (run,) = await run_metadata(pg_url, conversation_id)
    assert run["skills"] == f"{SKILL}:{skill_hashes[SKILL]}"


async def test_a_renamed_skill_is_written_again_under_a_new_key(
    app: FastAPI, engine: AsyncEngine, pg_url: str, heard: list[tuple[str, str]], tmp_path: Path
) -> None:
    seeded = await seed(
        app, engine, AgentSeed(AGENT_ID, skills=(SkillSeed(SKILL, references={"spec.md": "规范"}),))
    )
    services = services_of(app)
    skill_id = seeded.skills[SKILL]
    cache = tmp_path / "skills"

    def keys() -> set[str]:
        return {path.name for path in cache.iterdir()}

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await open_conversation(client)
        await run_once(client, conversation_id)
        (old_key,) = keys()

        await services.skills.rename(skill_id, SkillUpdateIn(name="storyboard-kit"))
        renamed_conversation = await open_conversation(client)
        await run_once(client, renamed_conversation)
        await run_once(client, conversation_id)
        (new_key,) = keys() - {old_key}

        current = await services.skills.read_file(skill_id, "references/spec.md")
        await services.skills.write_file(
            skill_id,
            "references/spec.md",
            DraftFileWriteIn(content="第二版", base_hash=current.hash),
            by=seeded.author,
        )
        await services.skills.publish(skill_id, SkillPublishIn(), by=seeded.author)
        await run_once(client, conversation_id)

    assert len(keys() - {old_key, new_key}) == 1, "发布新版本换一个目录"
    old_md = (cache / old_key / SKILL / "SKILL.md").read_text(encoding="utf-8")
    new_md = (cache / new_key / "storyboard-kit" / "SKILL.md").read_text(encoding="utf-8")
    assert "name: storyboard-rules\n" in old_md
    assert "name: storyboard-kit\n" in new_md
    assert (cache / new_key / "storyboard-kit" / "references" / "spec.md").is_file()
    _model, renamed_words = heard[1]
    assert "storyboard-kit" in renamed_words
    assert SKILL not in renamed_words
    runs = await run_metadata(pg_url, conversation_id)
    assert [run["skills"].split(":")[0] for run in runs] == [
        SKILL,
        "storyboard-kit",
        "storyboard-kit",
    ]


async def test_publishing_an_agent_is_picked_up_by_new_conversations_without_a_restart(
    app: FastAPI, engine: AsyncEngine, pg_url: str, heard: list[tuple[str, str]]
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID, instructions="旧"))
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        await run_once(client, await open_conversation(client))
        await republish(app, seeded, AgentSeed(AGENT_ID, instructions="新"))
        await run_once(client, await open_conversation(client))

    assert [words for _model, words in heard] == ["旧", "新"]


async def test_the_draft_entry_assembles_the_unpublished_draft(
    app: FastAPI, engine: AsyncEngine, heard: list[tuple[str, str]]
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID, instructions="已发布"))
    services = services_of(app)
    detail = await services.agent_config.detail(AGENT_ID)
    saved = await services.agent_config.save_draft(
        AGENT_ID,
        AgentDraftIn(
            config=agent_config(AgentSeed(AGENT_ID, instructions="还在改")),
            skill_ids=[],
            lock_version=detail.draft.lock_version,
        ),
        by=seeded.author,
    )

    store = PgStepStore(engine)
    resolved = await runtime_of(app).for_draft(AGENT_ID)
    async with resolved.agent.run_stream_events(
        "试试", conversation_id="draft-1", run_id="draft-run-1"
    ) as events:
        async for _event in events:
            pass

    assert heard == [(TEST_MODEL_NAME, "还在改")]
    (run,) = [one for one in await store.list_runs() if one.run_id == "draft-run-1"]
    assert run.metadata["agent_draft"] == "true"
    assert run.metadata["agent_draft_lock_version"] == str(saved.draft.lock_version)
    assert "agent_version_id" not in run.metadata
    assert (await services.agent_config.detail(AGENT_ID)).active_version is not None
    with pytest.raises(AgentUnavailable):
        await runtime_of(app).for_draft("nobody")


@pytest.mark.parametrize("with_default", [True, False], ids=["设了默认模型", "没设"])
async def test_titles_come_from_the_default_llm(
    app: FastAPI, engine: AsyncEngine, pg_url: str, with_default: bool
) -> None:
    seeded = await seed(app, engine, AgentSeed(AGENT_ID), models=(TITLE_MODEL,))
    if with_default:
        await services_of(app).model_providers.set_default_model(
            "llm", DefaultModelIn(provider_id=seeded.provider_id, model_name=TITLE_MODEL)
        )
    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await open_conversation(client)
        await run_once(client, conversation_id)
        title = await title_of(client, conversation_id, expect="分镜脚本")

    assert title == ("分镜脚本" if with_default else DEFAULT_TITLE)
