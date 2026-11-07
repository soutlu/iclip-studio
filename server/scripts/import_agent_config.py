from __future__ import annotations

import argparse
import asyncio
import io
import os
import sys
import uuid
import zipfile
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast, get_args

import yaml
from cue.assembly.config_services import ConfigServices, build_config_services
from cue.config.agent_config.config import AgentConfig
from cue.config.agent_config.models import AGENT_ID_PATTERN, RESERVED_AGENT_IDS
from cue.config.agent_config.schemas import (
    AgentCreateIn,
    AgentDraftIn,
    AgentOrderIn,
    AgentPublishIn,
    AgentUpdateIn,
)
from cue.config.model_providers.catalog import Declarations, ProviderDeclaration
from cue.config.model_providers.public import CredentialProbe, load_declarations
from cue.config.model_providers.schemas import (
    CredentialCreateIn,
    CustomModelCreateIn,
    DefaultModelIn,
    ModelProviderCreateIn,
)
from cue.config.skills.schemas import SkillPublishIn
from cue.errors import DomainError
from cue.file_store.pg import PgFileStore
from cue.model_connections import ModelConnection
from cue.model_vocab import ThinkingEffort
from cue.plugins.base import PluginFactory, PluginHost, PluginRegistry
from cue.settings import CREDENTIAL_ENCRYPTION_KEYS_ENV, CredentialKeysEnv, load_config
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.app.bootstrap import VIDEO_APP_ID
from iclip.config import load_runtime_config, resolve_settings
from iclip.platform.db.engine import build_engine

NOTE = "从文件配置切换"

INSTRUCTIONS_FILENAME = "instructions.md"

_AGENT_FIELDS = frozenset({"spec", "model", "name", "skills", "capabilities", "subagent"})
_SUBAGENT_FIELDS = frozenset(
    {"spec", "model", "skills", "capabilities", "timeout_seconds", "max_calls", "on_failure"}
)
_MODEL_FIELDS = frozenset(
    {"provider", "api", "api_key_env", "base_url", "model", "thinking", "context_window"}
)


class ImportRefused(Exception):
    pass


@dataclass(frozen=True)
class LegacyModel:
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


@dataclass
class CustomModelPlan:
    name: str
    api: str
    context_size: int | None
    thinking: list[ThinkingEffort]


@dataclass
class ProviderPlan:
    declaration: ProviderDeclaration
    credentials: list[CredentialPlan] = field(default_factory=list[CredentialPlan])
    custom_models: list[CustomModelPlan] = field(default_factory=list[CustomModelPlan])


@dataclass(frozen=True)
class ModelRef:
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


class OneTransaction:
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


async def _refuse_if_configured(services: ConfigServices) -> None:
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
    plan: ImportPlan, services: ConfigServices, conn: AsyncConnection, *, say: Callable[[str], None]
) -> ImportResult:
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

    await conn.execute(
        text(
            "INSERT INTO agent_runtime.sessions (id, app_id, agent_version_id)"
            " SELECT c.id, :app_id, a.active_version_id FROM iclip.conversations c"
            " LEFT JOIN agent_runtime.agents a ON a.id = c.agent_id"
            " ON CONFLICT (id) DO NOTHING"
        ),
        {"app_id": VIDEO_APP_ID},
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
    engine: AsyncEngine,
    plugins: PluginRegistry,
    credential_keys: Sequence[str],
    legacy_config: Path,
    agents_file: Path,
    skills_dir: Path,
    env: Mapping[str, str],
    dry_run: bool,
    credential_probe: CredentialProbe | None = None,
    say: Callable[[str], None] = print,
) -> ImportResult:
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
            services = build_config_services(
                cast("AsyncEngine", OneTransaction(conn)),
                credential_keys=credential_keys,
                plugins=plugins,
                probe=credential_probe,
            )
            result = await apply_plan(plan, services, conn, say=say)
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


@asynccontextmanager
async def deployment_plugins(
    runtime_config: Path, engine: AsyncEngine
) -> AsyncGenerator[PluginRegistry]:
    try:
        config = load_config(runtime_config)
    except (OSError, ValueError) as exc:
        raise ImportRefused(f"运行时配置 {runtime_config} 读不了：{exc}") from exc
    if config.plugins is None:
        yield {}
        return
    factory = cast("PluginFactory", config.plugins.factory)
    async with AsyncExitStack() as stack:
        try:
            bind = await stack.enter_async_context(factory(config.plugins.config))
        except (RuntimeError, ValidationError) as exc:
            raise ImportRefused(
                f"按运行时配置打开插件包失败：{exc}。配了 shot_video 或 video_breakdown 时插件包要向后端"
                "核对插件服务，先把后端起来、RUNTIME_INTERNAL_TOKEN 与运行时配置里的一致，再跑"
            ) from exc
        yield bind(PluginHost(files=PgFileStore(engine), model_connection=_no_model_calls))


async def _no_model_calls(declaration: str, model: str) -> ModelConnection:
    raise RuntimeError(f"切换配置时不调模型，插件却要查 {declaration}/{model} 的连接")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="把文件里的模型、agent 与技能配置写进数据库（一次性）"
    )
    parser.add_argument(
        "--runtime-config",
        type=Path,
        required=True,
        help="运行时服务的配置文件，插件登记表按它的 plugins 建",
    )
    parser.add_argument("--legacy-config", type=Path, required=True)
    parser.add_argument("--agents", type=Path, required=True)
    parser.add_argument("--skills", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    config = load_runtime_config(Path(os.environ.get("CONFIG_FILE", "configs/config.yaml")))
    try:
        keys = CredentialKeysEnv().key_list  # pyright: ignore[reportCallIssue]
    except ValidationError as exc:
        print(
            f"切换没有进行，什么都没写：{CREDENTIAL_ENCRYPTION_KEYS_ENV} 不合法：{exc.errors()[0]['msg']}",
            file=sys.stderr,
        )
        return 1

    async def go() -> None:
        engine = build_engine(resolve_settings(config).database_url)
        try:
            async with deployment_plugins(args.runtime_config, engine) as plugins:
                await run_import(
                    engine=engine,
                    plugins=plugins,
                    credential_keys=keys,
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
        print(f"切换没有进行，什么都没写：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
