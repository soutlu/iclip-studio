"""运行时服务的组合根：按设置建 engine、三块配置的服务与运行驱动这一整套对象，挂上 ``/v1`` 接口与错误信封。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from agent_runtime.assembly.agents import (
    AgentRuntime,
    AssemblySettings,
    ModelBuilder,
    build_runtime_model,
)
from agent_runtime.assembly.config_services import build_config_services
from agent_runtime.assembly.displays import build_display_registry
from agent_runtime.config.model_providers.public import CredentialProbe
from agent_runtime.file_store.announcing import AnnouncingFileStore, FileChange
from agent_runtime.file_store.pg import PgFileStore
from agent_runtime.harness.agents import DELEGATE_TOOL
from agent_runtime.harness.jobs import JobQueue, JobRow
from agent_runtime.harness.sessions import PgSessionStore, SessionApps
from agent_runtime.harness.stats_pg import PgRunStats
from agent_runtime.harness.step_store_pg import PgStepStore
from agent_runtime.harness.transcript.activity import ActivityState
from agent_runtime.harness.transcript.history import TranscriptHistory
from agent_runtime.harness.transcript.runner import ConversationRunner
from agent_runtime.harness.transcript.service import TranscriptService
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.harness.usage_ledger import UsageLedger
from agent_runtime.harness.usage_ledger_pg import PgConversationUsage
from agent_runtime.hooks import AppHooks, GatePayload, RunStartedPayload, TurnStartedPayload
from agent_runtime.http.admin.agents import create_agent_config_router
from agent_runtime.http.admin.mcp_servers import create_mcp_servers_router
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
from agent_runtime.http.stats import create_stats_router
from agent_runtime.http.streams import create_events_router, create_transcript_ws_router
from agent_runtime.http.transcript import create_transcript_router
from agent_runtime.http.workspace import create_workspace_router
from agent_runtime.live.frames import (
    FsChanged,
    FsChangeEntry,
    FsChangesPayload,
    SessionWorkChanged,
    timestamp_now,
)
from agent_runtime.live.hub import AppEventHub, SessionFileChanges
from agent_runtime.material_ledger.pg import PgMaterialLedger
from agent_runtime.plugins.base import PluginBinder, PluginHost, PluginRegistry
from agent_runtime.run_deps import AgentRunDeps, conversation_of
from agent_runtime.service.sessions import SessionService
from agent_runtime.settings import RuntimeSettings
from agent_runtime.transcript.wire import SessionActivityOut

TITLE = "agent-runtime"


def create_app(
    settings: RuntimeSettings,
    *,
    plugins: PluginRegistry | PluginBinder,
    credential_probe: CredentialProbe | None = None,
    engine: AsyncEngine | None = None,
    build_model: ModelBuilder = build_runtime_model,
    hook_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """按设置装出运行时服务。

    只建对象、不连库：engine 建出来时不连接，连接池在第一次请求时才开；运行驱动与事件分发在 lifespan 里
    起停，lifespan 结束时关掉回调用的 HTTP 客户端与自己建的 engine。合同导出因此只 import、建 app、不启动。

    ``plugins`` 是交给本服务的插件登记表：agent 装配按它造插件，管理接口校验 agent 配置（插件名、要求
    同挂的插件、参数）与列出可挂的插件也只看它，不另找插件。要写工作区或素材台账的插件给
    ``PluginBinder``，用本服务的工作区存储与素材台账绑定，写入才会发给订着这段会话的对话内容流连接。``credential_probe``
    不给就用真实的试连；``engine`` 不给就按 ``settings.database_url`` 自己建，给了由调用方负责关；
    ``build_model`` 是测试换模型替身的口子，``hook_transport`` 是测试接住回调请求的口子。
    """

    configure_logging(settings.log_level, settings.log_format)

    owns_engine = engine is None
    # 取连接前先 ping，理由同后端的 build_engine：被取消打断的清理可能把已关的连接留在池里。
    active_engine = (
        engine
        if engine is not None
        else create_async_engine(settings.database_url, pool_pre_ping=True)
    )

    # 会话活动在写入提交后同步交给应用事件流的集线器，按会话归属的应用分发；工作区文件变化同步交给按会话
    # 登记的对话内容流连接，跟着订阅走。
    session_store = PgSessionStore(active_engine)
    session_apps = SessionApps(session_store)
    event_hub = AppEventHub(session_apps.info_of)
    file_changes = SessionFileChanges()

    def on_activity(session_id: str, owner: uuid.UUID, state: ActivityState) -> None:
        event_hub.publish(
            SessionWorkChanged(
                session_id=session_id,
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
                payload=_activity_out(state),
            )
        )

    def on_file_change(
        _owner: uuid.UUID, session_id: uuid.UUID, path: str, change: FileChange
    ) -> None:
        file_changes.publish(
            FsChanged(
                session_id=str(session_id),
                timestamp=timestamp_now(),
                payload=FsChangesPayload(changes=(FsChangeEntry(path=path, change=change),)),
            )
        )

    file_store = PgFileStore(active_engine)
    # 分叉与按清单拷文件用底下这份，副本不算变更；插件与应用经接口写文件用会通知的那份。
    announcing_files = AnnouncingFileStore(file_store, on_file_change)
    material_ledger = PgMaterialLedger(active_engine)
    registry = (
        plugins
        if isinstance(plugins, Mapping)
        else plugins(PluginHost(files=announcing_files, ledger=material_ledger))
    )

    config_services = build_config_services(
        active_engine,
        credential_keys=settings.credential_encryption_keys,
        plugins=registry,
        probe=credential_probe,
    )
    skills = config_services.skills
    model_providers = config_services.model_providers
    mcp_servers = config_services.mcp_servers
    agent_config = config_services.agent_config

    # 运行这一侧：持久化、用量、队列、实时投影、历史、装配、会话、工作区与素材台账。
    step_store = PgStepStore(
        active_engine, max_snapshots_per_run=settings.agent_runs.max_snapshots_per_run
    )
    usage_ledger = UsageLedger(
        store=PgConversationUsage(active_engine), conversation_of=conversation_of
    )
    job_queue = JobQueue(active_engine, on_activity=on_activity)
    tool_displays = build_display_registry(registry, config_services.mcp_index)
    transcript_store = TranscriptStore()
    transcript_history = TranscriptHistory(step_store, job_queue, tool_displays, DELEGATE_TOOL)
    agent_runtime = AgentRuntime(
        agent_config=agent_config,
        skills=skills,
        model_providers=model_providers,
        mcp_servers=mcp_servers,
        sessions=session_store,
        settings=AssemblySettings(
            plugins=registry,
            step_store=step_store,
            usage_ledger=usage_ledger,
            live=transcript_store,
            display=tool_displays,
            skill_cache_dir=settings.agent_runs.skill_cache_dir,
            cache_size=settings.agent_runs.assembly_cache_size,
            build_model=build_model,
        ),
    )
    sessions = SessionService(
        sessions=session_store,
        version_for_new_session=agent_config.version_for_new_session,
        check_preview_target=agent_config.check_preview_target,
        queue=job_queue,
        history=transcript_history,
        files=file_store,
        ledger=material_ledger,
    )

    # 回调按会话归属的应用找地址；没配回调的应用不在表里。
    hook_client = httpx.AsyncClient(transport=hook_transport)
    hooks = AppHooks(
        hooks={app.id: app.hooks for app in settings.apps if app.hooks is not None},
        app_of=session_apps.app_of,
        client=hook_client,
    )

    async def is_preview(session_id: str) -> bool:
        # 查不到会话行就按普通会话报：开跑检查自己会因找不到会话而不放行。
        found = await session_apps.info_of(session_id)
        return found is not None and found.preview

    async def deps_for(row: JobRow) -> AgentRunDeps:
        preview = await is_preview(row.conversation_id)
        # 开跑检查：应用不放行就抛，这次运行记为失败。
        await hooks.gate(
            GatePayload(
                session_id=uuid.UUID(row.conversation_id),
                owner_user_id=row.owner_user_id,
                user_name=row.user_name,
                prompt_id=row.prompt_id,
                run_id=row.run_id,
                preview=preview,
            )
        )
        return AgentRunDeps(
            user_id=row.owner_user_id,
            conversation_id=row.conversation_id,
            user_name=row.user_name,
            preview=preview,
        )

    async def run_started(row: JobRow, run_id: str) -> None:
        states = await job_queue.activities([row.conversation_id])
        await hooks.run_started(
            RunStartedPayload(
                session_id=uuid.UUID(row.conversation_id),
                run_id=run_id,
                activity=_activity_out(states[row.conversation_id]),
                preview=await is_preview(row.conversation_id),
            )
        )

    async def turn_started(row: JobRow) -> None:
        await hooks.turn_started(
            TurnStartedPayload(
                session_id=uuid.UUID(row.conversation_id),
                text=row.text,
                preview=await is_preview(row.conversation_id),
            )
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
            on_turn_started=turn_started,
            on_run_started=run_started,
            display=tool_displays,
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        # MCP 服务的名册先读好，运行驱动一起来工具卡就按它画。分发先起：运行驱动启动时的清扫就可能改活动。
        await mcp_servers.load_index()
        await event_hub.start()
        await transcripts.runner.start()
        try:
            yield
        finally:
            await transcripts.runner.shutdown()
            await event_hub.stop()
            await hook_client.aclose()
            if owns_engine:
                await active_engine.dispose()

    app = FastAPI(title=TITLE, lifespan=lifespan)
    install_error_handlers(app)
    # 测试核对连接断开后实时状态有没有放开；经三块配置的服务种 agent、经装配入口核对缓存，与服务自己用的是
    # 同一份。
    app.state.transcript_store = transcript_store
    app.state.config_services = config_services
    app.state.agent_runtime = agent_runtime

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"status": "ok"}

    auth = build_app_auth(settings.apps)
    admin = APIRouter(prefix="/admin", dependencies=[Depends(auth.admin_app)])
    admin.include_router(create_skills_router(skills))
    admin.include_router(create_model_providers_router(model_providers))
    admin.include_router(create_default_models_router(model_providers))
    admin.include_router(create_mcp_servers_router(mcp_servers))
    admin.include_router(create_agent_config_router(agent_config, model_providers))

    v1 = APIRouter(prefix="/v1", dependencies=[Depends(auth.calling_app)])
    v1.include_router(admin)
    v1.include_router(create_sessions_router(sessions, job_queue, auth.calling_app))
    v1.include_router(create_transcript_router(transcripts, sessions, auth.calling_app))
    v1.include_router(
        create_workspace_router(announcing_files, material_ledger, sessions, auth.calling_app)
    )
    v1.include_router(create_agents_router(agent_runtime))
    v1.include_router(create_stats_router(PgRunStats(active_engine), auth.calling_app))
    app.include_router(v1)
    # WebSocket 不在 v1 的路由组里：组上的 Bearer 依赖只在 HTTP 请求上跑，两条连接自己认应用。
    app.include_router(create_events_router(auth.identify, event_hub))
    app.include_router(
        create_transcript_ws_router(auth.identify, transcripts, sessions, file_changes)
    )
    return app


def _activity_out(state: ActivityState) -> SessionActivityOut:
    return SessionActivityOut(
        busy=state.busy,
        pending_interaction=state.pending_interaction,
        last_turn_reason=state.last_turn_reason,
    )


__all__ = ["TITLE", "create_app"]
