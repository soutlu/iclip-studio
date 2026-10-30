"""一次性切换命令：照现在三个 agent（加一个子 agent）仿造的文件配置，切换后库里的供应商、密钥、模型、默认
模型、技能、agent 与对话会话都对；``--dry-run`` 不写；报错路径什么都不写。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml
from scripts.import_agent_config import ImportRefused, run_import
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import make_runtime_config
from tests.helpers.model_providers import KeyCheckingProbe
from tests.helpers.references import plant_user

KEY_A = "sk-import-a-0123456789"
KEY_B = "sk-import-b-0123456789"
ENV = {"T_QWEN_A": KEY_A, "T_QWEN_B": KEY_B}
BASE_URL = "https://dashscope.test/v1"

MODELS: dict[str, Any] = {
    "flash": {
        "provider": "alibaba",
        "api": "responses",
        "api_key_env": "T_QWEN_A",
        "base_url": BASE_URL,
        "model": "qwen3.8-flash",
        "thinking": "low",
    },
    "custom": {
        "provider": "alibaba",
        "api": "chat",
        "api_key_env": "T_QWEN_A",
        "base_url": BASE_URL,
        "model": "qwen-custom",
        "thinking": "high",
        "context_window": 65536,
    },
    "second-key": {
        "provider": "alibaba",
        "api": "responses",
        "api_key_env": "T_QWEN_B",
        "model": "qwen3.8-flash",
    },
}

AGENTS: dict[str, Any] = {
    "agent": {
        "director": {
            "spec": "director/agent.yaml",
            "name": "AI 导演",
            "model": "flash",
            "skills": ["director-guide"],
            "capabilities": ["workspace", "iclip_studio"],
        },
        "storyboard": {
            "spec": "storyboard/agent.yaml",
            "name": "分镜",
            "model": "custom",
            "skills": ["director-guide", "shot-rules"],
            "capabilities": ["workspace", "video_shots"],
        },
        "exact-replica": {
            "spec": "exact-replica/agent.yaml",
            "model": "second-key",
            "capabilities": ["workspace"],
            "subagent": [
                {
                    "spec": "shot-writer/agent.yaml",
                    "model": "flash",
                    "skills": ["shot-rules"],
                    "timeout_seconds": 300,
                    "max_calls": 3,
                    "on_failure": "子任务失败，主 agent 自己写",
                }
            ],
        },
    }
}


def skill_md(name: str) -> str:
    return f"---\nname: {name}\ndescription: {name} 的规则。\n---\n\n照着做。\n"


@pytest.fixture
def files(tmp_path: Path) -> Path:
    """仿造的旧文件：config.old.yaml、agents/（每个 spec 只有注释、旁边是 instructions.md）与 skills/。"""

    (tmp_path / "config.old.yaml").write_text(
        yaml.safe_dump(
            {"app": {"name": "旧"}, "models": MODELS, "conversations": {"title_model": "flash"}},
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    agents = tmp_path / "agents"
    for name in ("director", "storyboard", "exact-replica", "shot-writer"):
        folder = agents / name
        folder.mkdir(parents=True)
        (folder / "agent.yaml").write_text("# 身份来自 agents.yaml\n", encoding="utf-8")
        (folder / "instructions.md").write_text(f"你是 {name}。\n", encoding="utf-8")
    # 按文件里的先后排 sort_order：落盘时保留字典的先后。
    (agents / "agents.yaml").write_text(
        yaml.safe_dump(AGENTS, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
    for name in ("director-guide", "shot-rules"):
        folder = tmp_path / "skills" / name
        (folder / "references").mkdir(parents=True)
        (folder / "SKILL.md").write_text(skill_md(name), encoding="utf-8")
        (folder / "references" / "spec.md").write_text(f"{name} 细则", encoding="utf-8")
    return tmp_path


async def plant_root(engine: AsyncEngine) -> uuid.UUID:
    root = await plant_user(engine, "root-operator")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.users SET roles = '[\"root\"]'::jsonb WHERE id = :id"),
            {"id": root},
        )
    return root


async def plant_conversation(engine: AsyncEngine, owner: uuid.UUID, agent_id: str) -> uuid.UUID:
    conversation_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations"
                " (id, owner_user_id, agent_id, title, title_kind, created_at, updated_at)"
                " VALUES (:id, :owner, :agent, 't', 'custom', now(), now())"
            ),
            {"id": conversation_id, "owner": owner, "agent": agent_id},
        )
    return conversation_id


async def importing(
    engine: AsyncEngine,
    root: Path,
    *,
    dry_run: bool = False,
    env: Mapping[str, str] = ENV,
    agents_file: str = "agents/agents.yaml",
) -> list[str]:
    said: list[str] = []
    await run_import(
        config=make_runtime_config(),
        engine=engine,
        legacy_config=root / "config.old.yaml",
        agents_file=root / agents_file,
        skills_dir=root / "skills",
        env=env,
        dry_run=dry_run,
        credential_probe=KeyCheckingProbe({KEY_A, KEY_B}),
        say=said.append,
    )
    return said


async def counts(engine: AsyncEngine) -> dict[str, int]:
    tables = (
        "iclip.agents",
        "iclip.skills",
        "iclip.model_providers",
        "iclip.provider_credentials",
        "agent_runtime.sessions",
    )
    async with engine.connect() as conn:
        return {
            table: (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one()
            for table in tables
        }


async def rows(engine: AsyncEngine, sql: str, **params: Any) -> list[Any]:
    async with engine.connect() as conn:
        return list((await conn.execute(text(sql), params)).all())


async def test_the_cutover_writes_the_file_configuration_into_the_database(
    engine: AsyncEngine, base_env: None, files: Path
) -> None:
    root = await plant_root(engine)
    director_chat = await plant_conversation(engine, root, "director")
    gone_chat = await plant_conversation(engine, root, "old-bot")

    said = await importing(engine, files, dry_run=True)
    assert said[-1] == "--dry-run：以上内容没有写入"
    assert set((await counts(engine)).values()) == {0}, "dry-run 什么都不写"

    await importing(engine, files)

    # 供应商按声明名接入；密钥按（api_key_env，base_url）去重，第一把是默认。
    ((provider_id, provider_name, default_key),) = await rows(
        engine, "SELECT id, provider, default_credential_id FROM iclip.model_providers"
    )
    assert provider_name == "bailian"
    credentials = await rows(
        engine,
        "SELECT id, name FROM iclip.provider_credentials WHERE provider_id = :p ORDER BY created_at",
        p=provider_id,
    )
    assert [name for _id, name in credentials] == ["T_QWEN_A", "T_QWEN_B"]
    assert credentials[0][0] == default_key
    second_key = credentials[1][0]
    # 声明里没有的模型建成自己加的：接口、上下文长度与它配的档位。
    ((properties,),) = await rows(
        engine, "SELECT properties FROM iclip.provider_models WHERE name = 'qwen-custom'"
    )
    assert (properties["api"], properties["context_size"], properties["thinking"]) == (
        "chat",
        65536,
        ["high"],
    )
    ((title_model,),) = await rows(
        engine, "SELECT model_name FROM iclip.default_models WHERE type = 'llm'"
    )
    assert title_model == "qwen3.8-flash"

    skills = await rows(
        engine,
        "SELECT s.name, v.version FROM iclip.skills s"
        " JOIN iclip.skill_versions v ON v.id = s.latest_version_id ORDER BY s.name",
    )
    assert skills == [("director-guide", 1), ("shot-rules", 1)]

    agents = await rows(
        engine,
        "SELECT a.id, a.name, a.listed, a.sort_order, v.version, v.config"
        " FROM iclip.agents a JOIN iclip.agent_versions v ON v.id = a.active_version_id"
        " ORDER BY a.sort_order",
    )
    assert [(row[0], row[1], row[2], row[4]) for row in agents] == [
        ("director", "AI 导演", True, 1),
        ("storyboard", "分镜", True, 1),
        ("exact-replica", "exact-replica", True, 1),
        ("shot-writer", "shot-writer", False, 1),
    ]
    configs = {row[0]: row[5] for row in agents}
    assert configs["director"]["instructions"] == "你是 director。"
    assert configs["director"]["model"] == {
        "provider": "bailian",
        "name": "qwen3.8-flash",
        "credential_id": None,
        "settings": {"thinking": "low"},
    }
    assert configs["storyboard"]["model"]["settings"] == {"thinking": "high"}
    assert configs["exact-replica"]["model"]["credential_id"] == str(second_key)
    assert [tool["toolset"] for tool in configs["storyboard"]["tools"]] == [
        "workspace",
        "video_shots",
    ]
    assert all(
        tool == {"type": "cap", "toolset": tool["toolset"], "enabled": True, "parameters": {}}
        for tool in configs["storyboard"]["tools"]
    )
    assert configs["exact-replica"]["subagents"] == [
        {
            "agent": "shot-writer",
            "timeout_seconds": 300.0,
            "max_calls": 3,
            "on_failure": "子任务失败，主 agent 自己写",
        }
    ]
    bound = await rows(
        engine,
        "SELECT s.name FROM iclip.agent_version_skills b JOIN iclip.skills s ON s.id = b.skill_id"
        " JOIN iclip.agents a ON a.active_version_id = b.version_id WHERE a.id = 'storyboard'"
        " ORDER BY b.priority",
    )
    assert [name for (name,) in bound] == ["director-guide", "shot-rules"]

    sessions = dict(await rows(engine, "SELECT id, agent_version_id FROM agent_runtime.sessions"))
    ((director_v1,),) = await rows(
        engine, "SELECT active_version_id FROM iclip.agents WHERE id = 'director'"
    )
    assert sessions == {director_chat: director_v1, gone_chat: None}
    assert await rows(engine, "SELECT DISTINCT app_id FROM agent_runtime.sessions") == [("video",)]


async def test_the_cutover_refuses_to_run_twice(
    engine: AsyncEngine, base_env: None, files: Path
) -> None:
    await plant_root(engine)
    await importing(engine, files)
    before = await counts(engine)

    with pytest.raises(ImportRefused, match="已经有"):
        await importing(engine, files)
    assert await counts(engine) == before


def _rewrite(files: Path, name: str, change: dict[str, Any]) -> None:
    path = files / name
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    for dotted, value in change.items():
        target = data
        *parents, leaf = dotted.split(".")
        for key in parents:
            target = target[key]
        target[leaf] = value
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def give_a_spec_content(files: Path) -> None:
    (files / "agents" / "storyboard" / "agent.yaml").write_text(
        "# 注释之外还有\nmodel: openai:gpt\n", encoding="utf-8"
    )


def ask_for_an_undeclared_thinking_level(files: Path) -> None:
    _rewrite(files, "config.old.yaml", {"models.flash.thinking": "minimal"})


def use_a_provider_without_a_declaration(files: Path) -> None:
    _rewrite(files, "config.old.yaml", {"models.flash.provider": "openai"})


def rename_the_subagent_folder(files: Path) -> None:
    """子 agent 的标识取 spec 所在目录名，这个名字不合 agent 标识规则。"""

    (files / "agents" / "shot-writer").rename(files / "agents" / "Shot_Writer")
    _rewrite(
        files,
        "agents/agents.yaml",
        {"agent.exact-replica.subagent": [{"spec": "Shot_Writer/agent.yaml", "model": "flash"}]},
    )


@pytest.mark.parametrize(
    ("setup", "message"),
    [
        (give_a_spec_content, "除了注释还有内容"),
        (ask_for_an_undeclared_thinking_level, "不在声明 bailian 给 qwen3.8-flash 允许的档位里"),
        (use_a_provider_without_a_declaration, "provider openai 没有对应的供应商声明"),
        (rename_the_subagent_folder, "Shot_Writer 不合 agent 标识规则"),
    ],
    ids=["spec 有内容", "思考档位不在声明里", "provider 没有对应声明", "子 agent 名不合规矩"],
)
async def test_a_failed_check_writes_nothing(
    engine: AsyncEngine, base_env: None, files: Path, setup: Any, message: str
) -> None:
    await plant_root(engine)
    setup(files)

    with pytest.raises(ImportRefused, match=message):
        await importing(engine, files)
    assert set((await counts(engine)).values()) == {0}


async def test_a_failure_halfway_rolls_everything_back(
    engine: AsyncEngine, base_env: None, files: Path
) -> None:
    """一个插件不在本部署的登记表里：发布被拦下时前面写的供应商、技能都回滚掉。"""

    await plant_root(engine)
    _rewrite(files, "agents/agents.yaml", {"agent.director.capabilities": ["workspace", "video"]})

    with pytest.raises(Exception, match="video"):
        await importing(engine, files)
    assert set((await counts(engine)).values()) == {0}


async def test_a_missing_api_key_or_root_stops_before_writing(
    engine: AsyncEngine, base_env: None, files: Path
) -> None:
    with pytest.raises(ImportRefused, match="root"):
        await importing(engine, files)
    await plant_root(engine)
    with pytest.raises(ImportRefused, match="T_QWEN_B"):
        await importing(engine, files, env={"T_QWEN_A": KEY_A})
    assert set((await counts(engine)).values()) == {0}
