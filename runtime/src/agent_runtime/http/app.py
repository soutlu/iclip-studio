"""运行时服务的组合根：按设置建 engine 与三块配置的服务，挂上 ``/v1`` 接口与错误信封。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from agent_runtime.assembly.directories import (
    LibrarySkillDirectory,
    ProviderDirectory,
    RegistryPluginDirectory,
)
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
from agent_runtime.http.admin.agents import create_agent_config_router
from agent_runtime.http.admin.model_providers import (
    create_default_models_router,
    create_model_providers_router,
)
from agent_runtime.http.admin.skills import create_skills_router
from agent_runtime.http.auth import build_app_auth
from agent_runtime.http.errors import install_error_handlers
from agent_runtime.http.logging import configure_logging
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.settings import RuntimeSettings

TITLE = "agent-runtime"


def create_app(
    settings: RuntimeSettings,
    *,
    plugins: PluginRegistry,
    credential_probe: CredentialProbe | None = None,
    engine: AsyncEngine | None = None,
) -> FastAPI:
    """按设置装出运行时服务。

    只建对象、不连库：engine 建出来时不连接，连接池在第一次请求时才开，lifespan 结束时关掉自己建的
    engine；合同导出因此只 import、建 app、不启动。

    ``plugins`` 是交给本服务的插件登记表：管理接口校验 agent 配置（插件名、要求同挂的插件、参数）与列出
    可挂的插件，都只看这份登记表，不另找插件。``credential_probe`` 不给就用真实的试连；``engine`` 不给就按
    ``settings.database_url`` 自己建，给了由调用方负责关。
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

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        try:
            yield
        finally:
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
    app.include_router(v1)
    return app


__all__ = ["TITLE", "create_app"]
