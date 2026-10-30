"""一次性切换：把旧的文件配置（config.yaml 的 ``models`` 段与 ``conversations.title_model``、agents.yaml、
skills 目录）写进数据库，并给现有对话开运行时会话。

用法（在服务器上，与 ``scripts.admin`` 一样经 compose 跑）：

    docker compose run --rm server python -m scripts.import_agent_config \\
        --legacy-config configs/config.old.yaml --agents agents/agents.yaml --skills skills [--dry-run]

旧文件直接用 PyYAML 读，不经过新版的配置加载；插件登记表与数据库照常按 ``CONFIG_FILE``（缺省
``configs/config.yaml``，已删掉 ``models`` 段与 ``title_model``）建出来。写入都经各领域的服务，复用它们的
校验、试连与发布检查，所以新建密钥会真的连一次模型供应商。

检查清单（任何一条不满足就报错停下，什么都不写）：

- 库里还没有任何 agent、技能或供应商；
- 有一个在用的 root 账号，它记为这些配置的操作人（取最早建的那个）；
- 每个模型的 ``provider`` 恰好对应一份供应商声明的 ``pydantic_ai_provider``；声明里没有的模型要声明允许
  自己加；每个模型的 ``api_key_env`` 在环境变量里有值；
- 思考档位在声明允许的档位里（自己加的模型允许它配的那一档），不自动改档；
- agents.yaml 只有认得的字段；每个 spec 文件除注释外没有内容；引用的模型、技能都在；子 agent 的目录名合乎
  agent 标识规则，同一个子 agent 在几处的写法一致；
- 各技能导入与发布、各 agent 发布都通过检查（插件要在本部署的登记表里）。

``--dry-run`` 在同一个事务里把上面的事全做一遍再整体回滚，打印会写入的内容；正式运行在一个事务里做完，
任何一步失败全部回滚。
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
import uuid
import zipfile
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast, get_args

import yaml
from agent_runtime.errors import DomainError
from agent_runtime.model_vocab import ThinkingEffort
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.app.bootstrap import AgentServices, build_app
from iclip.config import RuntimeConfig, load_runtime_config, resolve_settings
from iclip.domains.agent_config.config import AgentConfig
from iclip.domains.agent_config.models import AGENT_ID_PATTERN, RESERVED_AGENT_IDS
from iclip.domains.agent_config.schemas import (
    AgentCreateIn,
    AgentDraftIn,
    AgentOrderIn,
    AgentPublishIn,
    AgentUpdateIn,
)
from iclip.domains.model_providers.catalog import Declarations, ProviderDeclaration
from iclip.domains.model_providers.public import CredentialProbe, load_declarations
from iclip.domains.model_providers.schemas import (
    CredentialCreateIn,
    CustomModelCreateIn,
    DefaultModelIn,
    ModelProviderCreateIn,
)
from iclip.domains.skills.schemas import SkillPublishIn
from iclip.platform.db.engine import build_engine

NOTE = "从文件配置切换"
"""技能与 agent 的 v1 发布说明。"""

INSTRUCTIONS_FILENAME = "instructions.md"

_AGENT_FIELDS = frozenset({"spec", "model", "name", "skills", "capabilities", "subagent"})
_SUBAGENT_FIELDS = frozenset(
    {"spec", "model", "skills", "capabilities", "timeout_seconds", "max_calls", "on_failure"}
)
_MODEL_FIELDS = frozenset(
    {"provider", "api", "api_key_env", "base_url", "model", "thinking", "context_window"}
)


class ImportRefused(Exception):
    """切换前的检查没通过；消息写明是哪一处。"""


# --- 读旧文件，定计划 --------------------------------------------------------------


@dataclass(frozen=True)
class LegacyModel:
    """config.yaml ``models`` 段的一项。"""

    key: str
    provider: str
    api: str
    api_key_env: str
    base_url: str | None
    model: str
    thinking: ThinkingEffort | None
    context_window: int | None


@dataclass
class CredentialPlan:
    name: str
    fields: dict[str, str]
    source: tuple[str, str | None]
    """（api_key_env，base_url）：同一组只建一把。"""


@dataclass
class CustomModelPlan:
    name: str
    api: str
    context_size: int | None
    thinking: list[ThinkingEffort]


@dataclass
class ProviderPlan:
    """按一份声明接入的供应商，名字就用声明名。第一把密钥是默认密钥。"""

    declaration: ProviderDeclaration
    credentials: list[CredentialPlan] = field(default_factory=list[CredentialPlan])
    custom_models: list[CustomModelPlan] = field(default_factory=list[CustomModelPlan])


@dataclass(frozen=True)
class ModelRef:
    """agent 配置里的 ``model``：供应商、模型名、第几把密钥与思考档位。"""

    provider: str
    name: str
    credential_index: int
    thinking: ThinkingEffort | None


@dataclass(frozen=True)
class SubagentPlan:
    agent: str
    timeout_seconds: float | None
    max_calls: int | None
    on_failure: str | None


@dataclass
class AgentPlan:
    agent_id: str
    name: str
    listed: bool
    instructions: str
    model_key: str
    skills: tuple[str, ...]
    plugins: tuple[str, ...]
    subagents: tuple[SubagentPlan, ...] = ()


@dataclass
class ImportPlan:
    providers: dict[str, ProviderPlan]
    models: dict[str, ModelRef]
    title_model: ModelRef | None
    skills: dict[str, dict[str, str]]
    agents: list[AgentPlan]
    """先子 agent（各自只出现一次），再顶层 agent，按文件里的先后；``sort_order`` 按顶层在前的先后排。"""


def _mapping(raw: object, where: str) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ImportRefused(f"{where} 应是键值对")
    return cast("dict[str, Any]", raw)


def _unknown(fields: Mapping[str, Any], allowed: frozenset[str], where: str) -> None:
    extra = sorted(set(fields) - allowed)
    if extra:
        raise ImportRefused(f"{where} 有不认识的字段：{'、'.join(extra)}")


def _read_yaml(path: Path) -> object:
    if not path.is_file():
        raise ImportRefused(f"文件不存在：{path}")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def read_legacy_models(path: Path) -> tuple[dict[str, LegacyModel], str | None]:
    """旧 config.yaml 的 ``models`` 段与 ``conversations.title_model``；其余段不看。"""

    raw = _mapping(_read_yaml(path), str(path))
    models: dict[str, LegacyModel] = {}
    for key, section in _mapping(raw.get("models"), "models").items():
        item = _mapping(section, f"models.{key}")
        _unknown(item, _MODEL_FIELDS, f"models.{key}")
        if "provider" not in item or "api_key_env" not in item:
            raise ImportRefused(f"models.{key} 要有 provider 与 api_key_env")
        context = item.get("context_window")
        thinking = item.get("thinking")
        if thinking is not None and thinking not in get_args(ThinkingEffort):
            raise ImportRefused(f"models.{key} 的思考档位 {thinking} 不是认得的档位")
        models[key] = LegacyModel(
            key=key,
            provider=str(item["provider"]),
            api=str(item.get("api", "chat")),
            api_key_env=str(item["api_key_env"]),
            base_url=item.get("base_url"),
            model=str(item.get("model") or key),
            thinking=thinking,
            context_window=int(context) if context is not None else None,
        )
    title = _mapping(raw.get("conversations"), "conversations").get("title_model")
    if title is not None and title not in models:
        raise ImportRefused(f"conversations.title_model 指向 {title}，models 段里没有")
    return models, title


def _declaration_for(provider: str, declarations: Declarations, key: str) -> ProviderDeclaration:
    matched = [one for one in declarations.values() if one.pydantic_ai_provider == provider]
    if not matched:
        raise ImportRefused(f"models.{key} 的 provider {provider} 没有对应的供应商声明")
    if len(matched) > 1:
        names = "、".join(sorted(one.name for one in matched))
        raise ImportRefused(f"models.{key} 的 provider {provider} 对应多份声明：{names}")
    return matched[0]


def plan_models(
    legacy: Mapping[str, LegacyModel], declarations: Declarations, env: Mapping[str, str]
) -> tuple[dict[str, ProviderPlan], dict[str, ModelRef]]:
    """按声明接入供应商、按（api_key_env，base_url）建密钥、补自己加的模型，交回每个旧模型名指到哪里。"""

    providers: dict[str, ProviderPlan] = {}
    refs: dict[str, ModelRef] = {}
    for key, model in legacy.items():
        declaration = _declaration_for(model.provider, declarations, key)
        plan = providers.setdefault(declaration.name, ProviderPlan(declaration=declaration))
        api_key = env.get(model.api_key_env, "").strip()
        if not api_key:
            raise ImportRefused(f"models.{key} 的 {model.api_key_env} 在环境变量里没有值")
        source = (model.api_key_env, model.base_url)
        index = next((i for i, one in enumerate(plan.credentials) if one.source == source), None)
        if index is None:
            if model.base_url is not None and declaration.field("base_url") is None:
                raise ImportRefused(
                    f"models.{key} 写了 base_url，声明 {declaration.name} 没有这个字段"
                )
            fields = {"api_key": api_key}
            if model.base_url is not None:
                fields["base_url"] = model.base_url
            taken = {one.name for one in plan.credentials}
            name = model.api_key_env
            suffix = 2
            while name in taken:
                name = f"{model.api_key_env} {suffix}"
                suffix += 1
            plan.credentials.append(CredentialPlan(name=name, fields=fields, source=source))
            index = len(plan.credentials) - 1
        declared = next(
            (one for one in declaration.models if one.name == model.model and one.type == "llm"),
            None,
        )
        if declared is not None:
            if model.thinking is not None and model.thinking not in declared.thinking:
                allowed = "、".join(declared.thinking) or "（不能设档位）"
                raise ImportRefused(
                    f"models.{key} 的思考档位 {model.thinking} 不在声明 {declaration.name} 给 "
                    f"{model.model} 允许的档位里：{allowed}"
                )
        else:
            if not declaration.custom_models:
                raise ImportRefused(
                    f"models.{key}：声明 {declaration.name} 里没有 {model.model}，也不允许自己加模型"
                )
            custom = next((one for one in plan.custom_models if one.name == model.model), None)
            if custom is None:
                custom = CustomModelPlan(
                    name=model.model, api=model.api, context_size=model.context_window, thinking=[]
                )
                plan.custom_models.append(custom)
            elif (custom.api, custom.context_size) != (model.api, model.context_window):
                raise ImportRefused(
                    f"models.{key} 与另一项都是 {model.model}，接口或上下文长度却不同"
                )
            if model.thinking is not None and model.thinking not in custom.thinking:
                custom.thinking.append(model.thinking)
        refs[key] = ModelRef(
            provider=declaration.name,
            name=model.model,
            credential_index=index,
            thinking=model.thinking,
        )
    return providers, refs


def _spec_instructions(base_dir: Path, spec: object, where: str) -> tuple[str, str]:
    """（spec 所在目录名，同目录 instructions.md 的内容）。spec 文件除注释外有内容就报错。"""

    if not isinstance(spec, str):
        raise ImportRefused(f"{where}.spec 应是文件路径")
    path = (base_dir / spec).resolve()
    if not path.is_file():
        raise ImportRefused(f"{where}.spec 指向的文件不存在：{path}")
    if yaml.safe_load(path.read_text(encoding="utf-8")) is not None:
        raise ImportRefused(f"{where}.spec（{path}）除了注释还有内容，切换不会带上它，先把它挪走")
    instructions = path.parent / INSTRUCTIONS_FILENAME
    content = instructions.read_text(encoding="utf-8") if instructions.is_file() else ""
    return path.parent.name, content.strip()


def _names(raw: object, where: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(isinstance(one, str) for one in raw):
        raise ImportRefused(f"{where} 应是名字列表")
    return tuple(cast("list[str]", raw))


def _check_agent_id(agent_id: str, where: str) -> None:
    if AGENT_ID_PATTERN.fullmatch(agent_id) is None or agent_id in RESERVED_AGENT_IDS:
        raise ImportRefused(
            f"{where} 的标识 {agent_id} 不合 agent 标识规则（小写字母开头，小写字母、数字或连字符，"
            "最多 40 个字符，不能用保留词）"
        )


def plan_agents(
    path: Path, models: Mapping[str, Any], skills: Mapping[str, Any]
) -> list[AgentPlan]:
    """读 agents.yaml：顶层 agent 上首页菜单，子 agent 各建成独立的 agent、不上菜单。"""

    raw = _mapping(_read_yaml(path), str(path))
    _unknown(raw, frozenset({"agent"}), str(path))
    base_dir = path.parent
    subs: dict[str, tuple[AgentPlan, dict[str, Any]]] = {}
    tops: list[AgentPlan] = []
    for agent_id, section in _mapping(raw.get("agent"), "agent").items():
        where = f"agent.{agent_id}"
        item = _mapping(section, where)
        _unknown(item, _AGENT_FIELDS, where)
        _check_agent_id(agent_id, where)
        _, instructions = _spec_instructions(base_dir, item.get("spec"), where)
        sub_plans: list[SubagentPlan] = []
        for index, sub_section in enumerate(item.get("subagent") or []):
            sub_where = f"{where}.subagent[{index}]"
            sub = _mapping(sub_section, sub_where)
            _unknown(sub, _SUBAGENT_FIELDS, sub_where)
            sub_id, sub_instructions = _spec_instructions(base_dir, sub.get("spec"), sub_where)
            _check_agent_id(sub_id, sub_where)
            sub_skills = _names(sub.get("skills"), f"{sub_where}.skills")
            sub_plugins = _names(sub.get("capabilities"), f"{sub_where}.capabilities")
            definition = {
                "spec": sub.get("spec"),
                "model": sub.get("model"),
                "skills": sub_skills,
                "capabilities": sub_plugins,
            }
            plan = AgentPlan(
                agent_id=sub_id,
                name=sub_id,
                listed=False,
                instructions=sub_instructions,
                model_key=str(sub.get("model")),
                skills=sub_skills,
                plugins=sub_plugins,
            )
            if sub_id in subs and subs[sub_id][1] != definition:
                raise ImportRefused(f"子 agent {sub_id} 在几处的写法不一致")
            subs.setdefault(sub_id, (plan, definition))
            sub_plans.append(
                SubagentPlan(
                    agent=sub_id,
                    timeout_seconds=sub.get("timeout_seconds"),
                    max_calls=sub.get("max_calls"),
                    on_failure=sub.get("on_failure"),
                )
            )
        tops.append(
            AgentPlan(
                agent_id=agent_id,
                name=str(item.get("name") or agent_id),
                listed=True,
                instructions=instructions,
                model_key=str(item.get("model")),
                skills=_names(item.get("skills"), f"{where}.skills"),
                plugins=_names(item.get("capabilities"), f"{where}.capabilities"),
                subagents=tuple(sub_plans),
            )
        )
    clash = sorted({plan.agent_id for plan in tops} & set(subs))
    if clash:
        raise ImportRefused(f"这些标识既是顶层 agent 又是子 agent：{'、'.join(clash)}")
    plans = [plan for plan, _ in subs.values()] + tops
    for plan in plans:
        if plan.model_key not in models:
            raise ImportRefused(f"agent {plan.agent_id} 的模型 {plan.model_key} 在 models 段里没有")
        missing = [name for name in plan.skills if name not in skills]
        if missing:
            raise ImportRefused(f"agent {plan.agent_id} 的技能不在技能目录里：{'、'.join(missing)}")
    return plans


def read_skills(directory: Path) -> dict[str, dict[str, str]]:
    """技能目录下每个带 ``SKILL.md`` 的子目录是一个技能：名字 → 文件（相对路径 → 内容）。"""

    if not directory.is_dir():
        raise ImportRefused(f"技能目录不存在：{directory}")
    found: dict[str, dict[str, str]] = {}
    for folder in sorted(path for path in directory.iterdir() if path.is_dir()):
        if not (folder / "SKILL.md").is_file():
            continue
        found[folder.name] = {
            path.relative_to(folder).as_posix(): path.read_text(encoding="utf-8")
            for path in sorted(folder.rglob("*"))
            if path.is_file() and path.name != ".DS_Store"
        }
    return found


def build_plan(
    *,
    legacy_config: Path,
    agents_file: Path,
    skills_dir: Path,
    declarations: Declarations,
    env: Mapping[str, str],
) -> ImportPlan:
    legacy, title = read_legacy_models(legacy_config)
    providers, refs = plan_models(legacy, declarations, env)
    skills = read_skills(skills_dir)
    agents = plan_agents(agents_file, refs, skills)
    return ImportPlan(
        providers=providers,
        models=refs,
        title_model=refs[title] if title is not None else None,
        skills=skills,
        agents=agents,
    )


# --- 一个事务里写 ----------------------------------------------------------------


class OneTransaction:
    """把各仓储的 ``engine.connect()`` / ``engine.begin()`` 都落到同一个连接、同一个外层事务上：``begin`` 开
    一个保存点，块里出错只回滚到保存点（与仓储自己开事务时的语义一致），整体提交或回滚由调用方决定。

    仓储只用这两个入口，所以这里只实现它们；交给 ``build_app`` 时按 ``AsyncEngine`` 传。"""

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    @asynccontextmanager
    async def connect(self) -> AsyncGenerator[AsyncConnection]:
        yield self._conn

    @asynccontextmanager
    async def begin(self) -> AsyncGenerator[AsyncConnection]:
        async with self._conn.begin_nested():
            yield self._conn


@dataclass(frozen=True)
class ImportResult:
    versions: dict[str, uuid.UUID]
    sessions: int
    unavailable_sessions: int


async def _operator(conn: AsyncConnection) -> uuid.UUID:
    found = (
        await conn.execute(
            text(
                "SELECT id FROM iclip.users WHERE is_active AND roles @> CAST(:root AS jsonb)"
                " ORDER BY created_at, id LIMIT 1"
            ),
            {"root": '["root"]'},
        )
    ).scalar_one_or_none()
    if found is None:
        raise ImportRefused(
            "库里没有在用的 root 账号，切换要记操作人；先用 scripts.admin set-roles 设一个"
        )
    return found


async def _refuse_if_configured(services: AgentServices) -> None:
    taken = [
        label
        for label, count in (
            ("agent", len((await services.agent_config.list()).items)),
            ("技能", len(await services.skills.catalog())),
            ("供应商", len((await services.model_providers.providers()).providers)),
        )
        if count
    ]
    if taken:
        raise ImportRefused(f"库里已经有{'、'.join(taken)}，切换只在空库上跑一次")


def _zip(name: str, files: Mapping[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, content in files.items():
            archive.writestr(f"{name}/{path}", content.encode("utf-8"))
    return buffer.getvalue()


def _agent_config(
    plan: AgentPlan, ref: ModelRef, credential_ids: Sequence[uuid.UUID]
) -> AgentConfig:
    model: dict[str, Any] = {"provider": ref.provider, "name": ref.name}
    if ref.credential_index != 0:
        model["credential_id"] = str(credential_ids[ref.credential_index])
    if ref.thinking is not None:
        model["settings"] = {"thinking": ref.thinking}
    return AgentConfig.model_validate(
        {
            "schema_version": 1,
            "instructions": plan.instructions,
            "model": model,
            "tools": [
                {"type": "cap", "toolset": name, "enabled": True, "parameters": {}}
                for name in plan.plugins
            ],
            "subagents": [
                {
                    "agent": sub.agent,
                    "timeout_seconds": sub.timeout_seconds,
                    "max_calls": sub.max_calls,
                    "on_failure": sub.on_failure,
                }
                for sub in plan.subagents
            ],
        }
    )


async def apply_plan(
    plan: ImportPlan, services: AgentServices, conn: AsyncConnection, *, say: Callable[[str], None]
) -> ImportResult:
    """按计划经各领域服务写入，最后给现有对话开会话；调用方负责提交或回滚。"""

    await _refuse_if_configured(services)
    by = await _operator(conn)
    providers = services.model_providers
    provider_ids: dict[str, uuid.UUID] = {}
    credential_ids: dict[str, list[uuid.UUID]] = {}
    for name, provider in plan.providers.items():
        created = await providers.create(
            ModelProviderCreateIn(
                name=name, provider=provider.declaration.name, label=provider.declaration.label
            )
        )
        provider_ids[name] = created.id
        say(f"供应商 {name}（声明 {provider.declaration.name}）")
        credential_ids[name] = []
        for credential in provider.credentials:
            made = await providers.create_credential(
                created.id,
                CredentialCreateIn(name=credential.name, fields=credential.fields),
                created_by=by,
            )
            credential_ids[name].append(made.id)
            default = "（默认）" if len(credential_ids[name]) == 1 else ""
            say(f"  密钥 {credential.name}{default}")
        for custom in provider.custom_models:
            await providers.add_model(
                created.id,
                CustomModelCreateIn.model_validate(
                    {
                        "name": custom.name,
                        "type": "llm",
                        "api": custom.api,
                        "context_size": custom.context_size,
                        "thinking": custom.thinking,
                    }
                ),
            )
            say(f"  自己加的模型 {custom.name}（{custom.api}，档位 {custom.thinking or '无'}）")
    if plan.title_model is not None:
        ref = plan.title_model
        await providers.set_default_model(
            "llm", DefaultModelIn(provider_id=provider_ids[ref.provider], model_name=ref.name)
        )
        say(f"默认对话模型 {ref.provider}/{ref.name}")

    skill_ids: dict[str, uuid.UUID] = {}
    for name, files in plan.skills.items():
        imported = await services.skills.import_archive(_zip(name, files), dry_run=False, by=by)
        if imported.skill_id is None:
            raise ImportRefused(f"技能 {name} 导入后没有拿到技能 id")
        version = await services.skills.publish(imported.skill_id, SkillPublishIn(note=NOTE), by=by)
        skill_ids[name] = imported.skill_id
        say(f"技能 {name} v{version.version}（{len(files)} 个文件）")

    agents = services.agent_config
    versions: dict[str, uuid.UUID] = {}
    for agent in plan.agents:
        ref = plan.models[agent.model_key]
        await agents.create(AgentCreateIn(id=agent.agent_id, name=agent.name), by=by)
        detail = await agents.detail(agent.agent_id)
        saved = await agents.save_draft(
            agent.agent_id,
            AgentDraftIn(
                config=_agent_config(agent, ref, credential_ids[ref.provider]),
                skill_ids=[skill_ids[name] for name in agent.skills],
                lock_version=detail.draft.lock_version,
            ),
            by=by,
        )
        version = await agents.publish(
            agent.agent_id,
            AgentPublishIn(note=NOTE, lock_version=saved.draft.lock_version),
            by=by,
        )
        if agent.listed:
            await agents.update(agent.agent_id, AgentUpdateIn(listed=True))
        versions[agent.agent_id] = version.id
        say(
            f"agent {agent.agent_id} v{version.version}"
            f"{'' if agent.listed else '（子 agent，不上首页）'}：模型 {ref.provider}/{ref.name}，"
            f"插件 {list(agent.plugins)}，技能 {list(agent.skills)}，"
            f"子 agent {[sub.agent for sub in agent.subagents]}"
        )
    order = [plan.agent_id for plan in plan.agents if plan.listed] + [
        plan.agent_id for plan in plan.agents if not plan.listed
    ]
    await agents.reorder(AgentOrderIn(ids=order))

    # 现有对话（含已删的）各开一个会话：agent 还在就指向它刚发布的 v1，不在了版本为空（运行时装不起来）。
    await conn.execute(
        text(
            "INSERT INTO agent_runtime.sessions (id, agent_version_id)"
            " SELECT c.id, a.active_version_id FROM iclip.conversations c"
            " LEFT JOIN iclip.agents a ON a.id = c.agent_id"
            " ON CONFLICT (id) DO NOTHING"
        )
    )
    counted = (
        await conn.execute(
            text(
                "SELECT count(*), count(*) FILTER (WHERE agent_version_id IS NULL)"
                " FROM agent_runtime.sessions"
            )
        )
    ).one()
    say(f"对话会话 {counted[0]} 个，其中 agent 已不在、不可用的 {counted[1]} 个")
    return ImportResult(versions=versions, sessions=counted[0], unavailable_sessions=counted[1])


async def run_import(
    *,
    config: RuntimeConfig,
    engine: AsyncEngine,
    legacy_config: Path,
    agents_file: Path,
    skills_dir: Path,
    env: Mapping[str, str],
    dry_run: bool,
    credential_probe: CredentialProbe | None = None,
    say: Callable[[str], None] = print,
) -> ImportResult:
    """读旧文件定计划，再在一个事务里写；``dry_run`` 时最后整体回滚。检查不过抛 ``ImportRefused``。"""

    plan = build_plan(
        legacy_config=legacy_config,
        agents_file=agents_file,
        skills_dir=skills_dir,
        declarations=load_declarations(),
        env=env,
    )
    async with engine.connect() as conn:
        transaction = await conn.begin()
        try:
            # 仓储只用 connect() / begin() 两个入口，OneTransaction 把它们落到这个事务上。
            app = build_app(
                config,
                engine=cast("AsyncEngine", OneTransaction(conn)),
                credential_probe=credential_probe,
            )
            result = await apply_plan(plan, app.state.agent_services, conn, say=say)
        except BaseException:
            await transaction.rollback()
            raise
        if dry_run:
            await transaction.rollback()
            say("--dry-run：以上内容没有写入")
        else:
            await transaction.commit()
            say("已写入")
    return result


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="把文件里的模型、agent 与技能配置写进数据库（一次性）"
    )
    parser.add_argument("--legacy-config", type=Path, required=True)
    parser.add_argument("--agents", type=Path, required=True)
    parser.add_argument("--skills", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    config = load_runtime_config(Path(os.environ.get("CONFIG_FILE", "configs/config.yaml")))

    async def go() -> None:
        engine = build_engine(resolve_settings(config).database_url)
        try:
            await run_import(
                config=config,
                engine=engine,
                legacy_config=args.legacy_config,
                agents_file=args.agents,
                skills_dir=args.skills,
                env=os.environ,
                dry_run=args.dry_run,
            )
        finally:
            await engine.dispose()

    try:
        asyncio.run(go())
    except (ImportRefused, DomainError) as exc:
        # 检查不过与领域服务的拒绝（如发布被编译检查拦下）都已整体回滚，原因原样给操作的人。
        print(f"切换没有进行，什么都没写：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
