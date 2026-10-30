"""运行时服务的组合根：按设置建 engine、三块配置的服务与运行驱动这一整套对象，挂上 ``/v1`` 接口与错误信封。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from agent_runtime.assembly.agents import (
    AgentRuntime,
    AssemblySettings,
    ModelBuilder,
    build_runtime_model,
)
from agent_runtime.assembly.directories import (
    LibrarySkillDirectory,
    ProviderDirectory,
    RegistryPluginDirectory,
)
from agent_runtime.assembly.displays import build_display_registry
from agent_runtime.assembly.models import PydanticAiCredentialProbe, require_known_providers
from agent_runtime.config.agent_config.public import (
    AgentConfigService,
    AgentReferences,
    SqlAgentStore,
)
from agent_runtime.config.model_providers.public import (
    CredentialCipher,
    CredentialProbe,
    ModelProviderService,
    SqlModelProviderStore,
    load_declarations,
)
from agent_runtime.config.skills.public import SkillsService, SqlSkillStore
from agent_runtime.file_store.pg import PgFileStore
from agent_runtime.harness.agents import DELEGATE_TOOL
from agent_runtime.harness.jobs import JobQueue, JobRow
from agent_runtime.harness.sessions import PgSessionStore
from agent_runtime.harness.step_store_pg import PgStepStore
from agent_runtime.harness.transcript.history import TranscriptHistory
from agent_runtime.harness.transcript.runner import ConversationRunner
from agent_runtime.harness.transcript.service import TranscriptService
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.harness.usage_ledger import UsageLedger
from agent_runtime.harness.usage_ledger_pg import PgConversationUsage
from agent_runtime.http.admin.agents import create_agent_config_router
from agent_runtime.http.admin.model_providers import (
    create_default_models_router,
    create_model_providers_router,
)
from agent_runtime.http.admin.skills import create_skills_router
from agent_runtime.http.agents import create_agents_router
from agent_runtime.http.auth import build_app_auth
from agent_runtime.http.errors import install_error_handlers
from agent_runtime.http.logging import configure_logging
from agent_runtime.http.sessions import create_sessions_router
from agent_runtime.http.transcript import create_transcript_router
from agent_runtime.http.workspace import create_workspace_router
from agent_runtime.material_ledger.pg import PgMaterialLedger
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.run_deps import AgentRunDeps, conversation_of
from agent_runtime.service.sessions import SessionService
from agent_runtime.settings import RuntimeSettings

TITLE = "agent-runtime"


def create_app(
    settings: RuntimeSettings,
    *,
    plugins: PluginRegistry,
    credential_probe: CredentialProbe | None = None,
    engine: AsyncEngine | None = None,
    build_model: ModelBuilder = build_runtime_model,
) -> FastAPI:
    """按设置装出运行时服务。

    只建对象、不连库：engine 建出来时不连接，连接池在第一次请求时才开；运行驱动在 lifespan 里起停，
    lifespan 结束时关掉自己建的 engine。合同导出因此只 import、建 app、不启动。

    ``plugins`` 是交给本服务的插件登记表：agent 装配按它造插件，管理接口校验 agent 配置（插件名、要求
    同挂的插件、参数）与列出可挂的插件也只看它，不另找插件。``credential_probe`` 不给就用真实的试连；
    ``engine`` 不给就按 ``settings.database_url`` 自己建，给了由调用方负责关；``build_model`` 是测试换
    模型替身的口子。
    """

    configure_logging(settings.log_level, settings.log_format)

    owns_engine = engine is None
    # 取连接前先 ping，理由同后端的 build_engine：被取消打断的清理可能把已关的连接留在池里。
    active_engine = (
        engine
        if engine is not None
        else create_async_engine(settings.database_url, pool_pre_ping=True)
    )

    # agent 配置与技能库、模型供应商互相要用：那两边经端口问 agent 表「谁在用」，agent 配置经端口查它们。
    # 先建 agent 的仓储交给那两边，再用它们的服务装 agent 配置。
    agent_store = SqlAgentStore(active_engine)
    agent_references = AgentReferences(agent_store)
    skills = SkillsService(SqlSkillStore(active_engine), usages=agent_references)
    declarations = load_declarations()
    require_known_providers(declarations)
    model_providers = ModelProviderService(
        SqlModelProviderStore(active_engine),
        declarations=declarations,
        cipher=CredentialCipher(settings.credential_encryption_keys),
        probe=credential_probe if credential_probe is not None else PydanticAiCredentialProbe(),
        usages=agent_references,
    )
    agent_config = AgentConfigService(
        agent_store,
        models=ProviderDirectory(model_providers),
        plugins=RegistryPluginDirectory(plugins),
        skills=LibrarySkillDirectory(skills),
    )

    # 运行这一侧，与后端组合根同一套：持久化、用量、队列、实时投影、历史、装配、会话、工作区与素材台账。
    step_store = PgStepStore(
        active_engine, max_snapshots_per_run=settings.agent_runs.max_snapshots_per_run
    )
    usage_ledger = UsageLedger(
        store=PgConversationUsage(active_engine), conversation_of=conversation_of
    )
    job_queue = JobQueue(active_engine)
    tool_displays = build_display_registry(plugins)
    transcript_store = TranscriptStore()
    transcript_history = TranscriptHistory(step_store, job_queue, tool_displays, DELEGATE_TOOL)
    session_store = PgSessionStore(active_engine)
    agent_runtime = AgentRuntime(
        agent_config=agent_config,
        skills=skills,
        model_providers=model_providers,
        sessions=session_store,
        settings=AssemblySettings(
            plugins=plugins,
            step_store=step_store,
            usage_ledger=usage_ledger,
            live=transcript_store,
            display=tool_displays,
            skill_cache_dir=settings.agent_runs.skill_cache_dir,
            cache_size=settings.agent_runs.assembly_cache_size,
            build_model=build_model,
        ),
    )
    file_store = PgFileStore(active_engine)
    material_ledger = PgMaterialLedger(active_engine)
    sessions = SessionService(
        sessions=session_store,
        version_for_new_session=agent_config.version_for_new_session,
        queue=job_queue,
        history=transcript_history,
        files=file_store,
        ledger=material_ledger,
    )

    async def deps_for(row: JobRow) -> AgentRunDeps:
        return AgentRunDeps(
            user_id=row.owner_user_id,
            conversation_id=row.conversation_id,
            user_name=row.user_name,
        )

    transcripts = TranscriptService(
        store=transcript_store,
        history=transcript_history,
        queue=job_queue,
        ledger=material_ledger,
        runner=ConversationRunner(
            agents=agent_runtime,
            store=transcript_store,
            queue=job_queue,
            snapshots=step_store,
            history=transcript_history,
            deps_for=deps_for,
            heartbeat_seconds=settings.agent_runs.heartbeat_seconds,
            lease_seconds=settings.agent_runs.lease_seconds,
            sweep_seconds=settings.agent_runs.sweep_seconds,
            max_attempts=settings.agent_runs.max_attempts,
            compaction_max_fraction=settings.compaction.max_fraction,
            compaction_keep_messages=settings.compaction.keep_messages,
            display=tool_displays,
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        await transcripts.runner.start()
        try:
            yield
        finally:
            await transcripts.runner.shutdown()
            if owns_engine:
                await active_engine.dispose()

    app = FastAPI(title=TITLE, lifespan=lifespan)
    install_error_handlers(app)

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"status": "ok"}

    auth = build_app_auth(settings.apps)
    admin = APIRouter(prefix="/admin", dependencies=[Depends(auth.admin_app)])
    admin.include_router(create_skills_router(skills))
    admin.include_router(create_model_providers_router(model_providers))
    admin.include_router(create_default_models_router(model_providers))
    admin.include_router(create_agent_config_router(agent_config))

    v1 = APIRouter(prefix="/v1", dependencies=[Depends(auth.calling_app)])
    v1.include_router(admin)
    v1.include_router(create_sessions_router(sessions, job_queue))
    v1.include_router(create_transcript_router(transcripts))
    v1.include_router(create_workspace_router(file_store, material_ledger))
    v1.include_router(create_agents_router(agent_runtime))
    app.include_router(v1)
    return app


__all__ = ["TITLE", "create_app"]
