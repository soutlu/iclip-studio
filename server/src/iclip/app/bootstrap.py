from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal

import httpx
import procrastinate
import structlog
from agent_runtime.errors import NotFound
from agent_runtime.file_store.pg import PgFileStore
from agent_runtime.file_store.store import (
    FileEntry,
    FileStore,
    SearchResult,
    StoredFile,
)
from agent_runtime.harness.agents import DELEGATE_TOOL
from agent_runtime.harness.jobs import JobQueue, JobRow
from agent_runtime.harness.sessions import PgSessionStore
from agent_runtime.harness.step_store_pg import PgStepStore
from agent_runtime.harness.transcript.activity import ActivityState
from agent_runtime.harness.transcript.history import TranscriptHistory
from agent_runtime.harness.transcript.runner import ConversationRunner
from agent_runtime.harness.transcript.service import TranscriptService
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.harness.usage_ledger import UsageLedger
from agent_runtime.harness.usage_ledger_pg import PgConversationUsage
from agent_runtime.material_ledger.pg import PgMaterialLedger
from agent_runtime.plugins.workspace.scope import parse_namespace
from agent_runtime.run_deps import AgentRunDeps
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from iclip.app.agent_config import (
    LibrarySkillDirectory,
    ProviderDirectory,
    RegistryPluginDirectory,
)
from iclip.app.agent_runtime import (
    AgentRuntime,
    AssemblySettings,
    ModelBuilder,
    build_runtime_model,
)
from iclip.app.brand_templates import template_font_prober
from iclip.app.conversation_film import ConversationFilmAdapter
from iclip.app.conversation_fork import ForkLineageAdapter, ForkTranscriptAdapter, WorkspaceCopier
from iclip.app.conversation_same_style import LibrarySameStyleSource, SameStyleCopier
from iclip.app.conversation_workspace import (
    ConversationWorkspace,
    validate_film,
    validate_film_run,
    validate_video_shots,
)
from iclip.app.errors import install_error_handlers
from iclip.app.generation_live import AnnouncingGenerationRepository
from iclip.app.library_tagging import (
    HitCaseTreatments,
    LibrarySourceText,
    build_library_tagger,
)
from iclip.app.logging import configure_logging
from iclip.app.model_providers import PydanticAiCredentialProbe, require_known_providers
from iclip.app.plugin_registry import build_display_registry, build_plugin_registry
from iclip.app.prompt_attachments import PromptAttachmentImporter
from iclip.app.reference_breakdown import build_reference_breakdown
from iclip.app.reference_test_video import GenerationTestVideos
from iclip.app.whole_film_drafts import GenerationDraftReferences
from iclip.app.whole_film_exports import WholeFilmExportAdapter
from iclip.config import (
    QWEN_API_KEY_ENV,
    ObjectStoreEnv,
    ResolvedMediaGeneration,
    ResolvedProductCatalog,
    ResolvedQwenService,
    RuntimeConfig,
    resolve_settings,
)
from iclip.domains.agent_config.infra_sql import SqlAgentStore
from iclip.domains.agent_config.module import build_agent_config_module
from iclip.domains.agent_config.public import AgentConfigService, AgentReferences
from iclip.domains.agents.transcript_api import LiveConnections, create_transcript_router
from iclip.domains.audit.module import build_audit_module
from iclip.domains.audit.reports_pg import PgAuditReports
from iclip.domains.brand_templates.infra_sql import SqlBrandTemplateStore
from iclip.domains.brand_templates.module import BrandTemplatesModule, build_brand_templates_module
from iclip.domains.collections.infra_sql import SqlCollectionRepository
from iclip.domains.collections.module import build_collections_module
from iclip.domains.conversations.infra_sql import (
    SqlConversationRepository,
    SqlWholeFilmDraftStore,
)
from iclip.domains.conversations.module import build_conversations_module
from iclip.domains.conversations.service import CollectionInfo, ConversationActivity
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.module import (
    GenerationModule,
    ImageModelConfig,
    QwenServiceConfig,
    build_generation_module,
)
from iclip.domains.generation.ports import ConversationLineage
from iclip.domains.generation.queue import GenerationQueueSettings, queue_dsn
from iclip.domains.generation.qwen import QwenEndpoint
from iclip.domains.generation.render import RenderClient, RenderSetup
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_UPLOAD
from iclip.domains.generation.service import ClearCompletion, SettledRecords, VideoEnhanceSpec
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.accounts import CookieAuthSettings
from iclip.domains.identity.infra_sql import DB_SCHEMA
from iclip.domains.identity.middleware import PrincipalMiddleware
from iclip.domains.identity.module import SsoRuntime, build_identity_module
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.public import ActAs, Principal
from iclip.domains.identity.sso import SsoVerifier
from iclip.domains.inspirations.infra_sql import PgInspirationVideos
from iclip.domains.inspirations.module import build_inspirations_module
from iclip.domains.inspirations.service import NoStyleDirectory
from iclip.domains.library.module import build_library_module
from iclip.domains.library.reports_pg import PgLibraryReports
from iclip.domains.model_providers.catalog import load_declarations
from iclip.domains.model_providers.cipher import CredentialCipher
from iclip.domains.model_providers.infra_sql import SqlModelProviderStore
from iclip.domains.model_providers.module import build_model_providers_module
from iclip.domains.model_providers.public import ModelProviderService
from iclip.domains.model_providers.repository import CredentialProbe
from iclip.domains.products.catalog_pg import PgStyleDirectory
from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.domains.references.module import BreakdownSetup, build_references_module
from iclip.domains.references.repository import VideoBreakdowns
from iclip.domains.skills.infra_sql import SqlSkillStore
from iclip.domains.skills.module import build_skills_module
from iclip.domains.skills.public import SkillsService
from iclip.domains.tagging.infra_sql import SqlTagStore
from iclip.domains.tagging.module import TaggingSetup, build_tagging_module
from iclip.domains.tagging.repository import Tagger
from iclip.domains.tasks.infra_sql import SqlTaskRepository
from iclip.domains.tasks.module import build_tasks_module
from iclip.domains.tracking.infra_sql import SqlTrackingRepository
from iclip.domains.tracking.module import build_tracking_module
from iclip.domains.uploads.module import UploadsModule, build_uploads_module
from iclip.domains.uploads.service import FetchBytes
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import MediaCodec, detect_codec
from iclip.platform.media.fonts import ProbeFont
from iclip.platform.media.process import ffmpeg_available
from iclip.platform.object_store.oss import (
    OssObjectStore,
    OssSettings,
    oss_fetch_url,
    validate_internal_endpoint,
    validate_public_url_base,
)
from iclip.platform.object_store.store import (
    PublicBucket,
    PublicObjectStore,
    ServerUploadSigner,
)
from iclip.platform.outbound.fetch import PublicFetcher
from iclip.plugins.iclip_studio.film.film import FILM_PATH, RUN_PATH
from iclip.plugins.shot_document import SHOTS_PATH

_logger = structlog.stdlib.get_logger(__name__)


def _object_store(
    settings: ObjectStoreEnv | None,
    injected: PublicBucket | None,
) -> tuple[PublicBucket | None, Callable[[str], str], ServerUploadSigner | None]:
    """桶、服务端下载用的地址换算与给别的服务端签上传地址的端口。注入了桶（测试）时没有签名端口，
    成片导出开不了。"""

    if injected is not None:
        return injected, _as_is, None
    if settings is None:
        return None, _as_is, None
    oss = OssSettings(
        bucket=settings.bucket,
        endpoint=settings.endpoint,
        access_key_id=settings.access_key_id,
        access_key_secret=settings.access_key_secret,
        public_url_base=validate_public_url_base(settings.public_url_base),
        internal_endpoint=validate_internal_endpoint(settings.internal_endpoint),
    )
    store = OssObjectStore(oss)
    return store, oss_fetch_url(oss), store


def _as_is(url: str) -> str:
    return url


def _namespace_owner(namespace: str) -> tuple[uuid.UUID, uuid.UUID] | None:
    try:
        return parse_namespace(namespace)
    except ValueError:
        return None


class AnnouncingFileStore:
    def __init__(self, inner: FileStore, live: LiveConnections) -> None:
        self._inner = inner
        self._live = live

    async def read(self, namespace: str, path: str) -> StoredFile | None:
        return await self._inner.read(namespace, path)

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        entry = await self._inner.write(namespace, path, content, expected_version=expected_version)
        self._announce(namespace, entry.path, "created" if entry.version == 1 else "modified")
        return entry

    async def delete(self, namespace: str, path: str) -> bool:
        deleted = await self._inner.delete(namespace, path)
        if deleted:
            self._announce(namespace, path, "deleted")
        return deleted

    def _announce(
        self, namespace: str, path: str, change: Literal["created", "modified", "deleted"]
    ) -> None:
        addressed = _namespace_owner(namespace)
        if addressed is not None:
            owner, conversation_id = addressed
            self._live.announce_fs_changed(owner, conversation_id, path=path, change=change)

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        return await self._inner.entries(namespace, prefix=prefix)

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult:
        return await self._inner.search(namespace, query, limit=limit)


def _conversation_of(deps: object) -> str | None:
    return deps.conversation_id if isinstance(deps, AgentRunDeps) else None


@dataclass(frozen=True, slots=True)
class AgentServices:
    """挂在 ``app.state.agent_services`` 上的 agent 配置相关服务，供切换命令
    （``scripts/import_agent_config.py``）复用：它们只能由 ``build_app`` 连同真实的插件登记表一起建出来。"""

    skills: SkillsService
    model_providers: ModelProviderService
    agent_config: AgentConfigService
    sessions: PgSessionStore
    runtime: AgentRuntime


def _require_ffmpeg(required: bool) -> None:
    if required and not ffmpeg_available():
        raise RuntimeError(
            "PATH 上找不到 ffmpeg/ffprobe：取帧与出图要用它抽帧切格，视频裁剪拼接要用它切段合成，"
            "视频拆解要用它读时长与抽帧"
        )


def _product_catalog_engine(
    settings: ResolvedProductCatalog | None, injected: AsyncEngine | None
) -> AsyncEngine | None:

    if settings is None:
        return None
    return injected if injected is not None else _read_only_engine(settings.database_url)


def _read_only_engine(database_url: str) -> AsyncEngine:
    return build_engine(
        database_url,
        connect_args={"server_settings": {"default_transaction_read_only": "on"}},
    )


def _media_codec(required: bool, injected: MediaCodec | None) -> MediaCodec | None:
    if injected is not None:
        return injected
    return detect_codec() if required else None


def _local_concurrency(configured: int | None, codec: MediaCodec) -> int:
    return configured if configured is not None else codec.concurrency


def _qwen_service(resolved: ResolvedQwenService | None) -> QwenServiceConfig | None:
    if resolved is None:
        return None
    return QwenServiceConfig(
        endpoint=QwenEndpoint(
            url=resolved.url, api_key=resolved.api_key, timeout_seconds=resolved.timeout_seconds
        ),
        concurrency=resolved.concurrency,
    )


def _generation_module(
    settings: ResolvedMediaGeneration,
    repo: GenerationRepository,
    *,
    act_as: ActAs,
    clear_completion: ClearCompletion,
    lineage: ConversationLineage,
    object_store: PublicObjectStore,
    queue_connector: procrastinate.BaseConnector,
    media_codec: MediaCodec,
    compose_concurrency: int,
    fetch_url: Callable[[str], str],
    render: RenderSetup | None,
) -> GenerationModule:
    enhance = settings.video_enhance
    return build_generation_module(
        repo,
        act_as=act_as,
        clear_completion=clear_completion,
        lineage=lineage,
        video=VideoProviderSettings(
            submit_url=settings.video_submit_url,
            status_base_url=settings.video_status_base_url,
            api_key=settings.video_api_key,
            enhance_submit_url=None if enhance is None else enhance.submit_url,
        ),
        video_enhance=None
        if enhance is None
        else VideoEnhanceSpec(
            model=enhance.model, resolutions=enhance.resolutions, fps=enhance.fps
        ),
        video_default_model=settings.video_model,
        video_allowed_models=settings.video_allowed_models,
        image_models=tuple(
            ImageModelConfig(
                name=model.name,
                api_base=model.api_base,
                concurrency=model.concurrency,
                text_to_image_task=model.text_to_image_task,
                image_edit_task=model.image_edit_task,
            )
            for model in settings.image_models
        ),
        image_default_model=settings.image_default_model,
        image_env=settings.image_env,
        image_text_to_image_task=settings.image_text_to_image_task,
        image_edit_task=settings.image_edit_task,
        object_store=object_store,
        queue_connector=queue_connector,
        media_codec=media_codec,
        fetch_url=fetch_url,
        queue_settings=GenerationQueueSettings(
            poll_interval_seconds=settings.poll_interval_seconds,
            job_timeout_seconds=settings.job_timeout_seconds,
            compose_concurrency=compose_concurrency,
        ),
        subtitles=_qwen_service(settings.subtitle),
        music=_qwen_service(settings.music),
        render=render,
    )


def build_app(
    config: RuntimeConfig,
    *,
    engine: AsyncEngine | None = None,
    build_model: ModelBuilder = build_runtime_model,
    sso_verifier: SsoVerifier | None = None,
    pms_client: PmsUserClient | None = None,
    object_store: PublicBucket | None = None,
    whole_film_render_transport: httpx.AsyncBaseTransport | None = None,
    image_fetcher: FetchBytes | None = None,
    queue_connector: procrastinate.BaseConnector | None = None,
    product_catalog_engine: AsyncEngine | None = None,
    reference_breakdowns: VideoBreakdowns | None = None,
    library_tagger: Tagger | None = None,
    credential_probe: CredentialProbe | None = None,
    brand_font_probe: ProbeFont | None = None,
    media_codec: MediaCodec | None = None,
) -> FastAPI:
    """按运行配置装出整个应用；只建对象、不连库，连接与后台循环都留给 lifespan。agent 不在这里装配，
    每次运行按对话固定的版本从库里装。``build_model`` 是测试换模型替身的口子。"""

    settings = resolve_settings(config)
    if settings.db_schema != DB_SCHEMA:
        raise RuntimeError(f"db.schema 当前固定为 {DB_SCHEMA}（declarative 元数据定义期绑定）")
    configure_logging(settings.log_level, settings.log_format)

    owns_engine = engine is None
    active_engine = engine if engine is not None else build_engine(settings.database_url)
    sessions = async_sessionmaker(active_engine, expire_on_commit=False)

    identity = build_identity_module(
        sessions,
        CookieAuthSettings(
            secret=settings.security.secret,
            lifetime_seconds=settings.security.lifetime_seconds,
            cookie_secure=settings.security.cookie_secure,
        ),
        SsoRuntime(
            base_url=settings.sso.base_url,
            app_name=settings.sso.app_name,
            redirect_url=settings.sso.redirect_url,
            pms_base_url=settings.sso.pms_base_url,
            oauth_name=settings.sso.oauth_name,
            root_email=settings.sso.root_email,
        )
        if settings.sso is not None
        else None,
        sso_verifier=sso_verifier,
        pms_client=pms_client,
    )
    public_objects, fetch_url, server_uploads = _object_store(settings.object_store, object_store)
    _require_ffmpeg(settings.ffmpeg_required)
    # 一个客户端：生成队列经它提交、轮询，导出端点经它读进度、取消；lifespan 结束时关。
    render_client = (
        None
        if settings.whole_film_render is None
        else RenderClient(settings.whole_film_render.url, transport=whole_film_render_transport)
    )
    codec = _media_codec(settings.ffmpeg_required, media_codec)
    compose_concurrency = (
        _local_concurrency(settings.media_generation.compose_concurrency, codec)
        if settings.media_generation is not None and codec is not None
        else None
    )
    breakdown_concurrency = (
        _local_concurrency(settings.iclip_studio.breakdown_concurrency, codec)
        if settings.iclip_studio is not None and codec is not None
        else None
    )
    if codec is not None:
        _logger.info(
            "本地视频编解码已选定",
            codec=codec.name,
            hardware=codec.hardware,
            compose_concurrency=compose_concurrency,
            breakdown_concurrency=breakdown_concurrency,
        )
    if settings.shot_tools_missing:
        _logger.warning(
            "配了 shot_video 段但取帧与出图装不起来", missing=list(settings.shot_tools_missing)
        )
    if settings.media_generation is None or settings.media_generation.subtitle is None:
        _logger.warning(
            "字幕识别未启用",
            media_generation=settings.media_generation is not None,
            requires=f"media_generation.subtitle 段与千问AI平台的 API Key {QWEN_API_KEY_ENV}",
        )
    if settings.media_generation is None or settings.media_generation.music is None:
        _logger.warning(
            "音乐生成未启用",
            media_generation=settings.media_generation is not None,
            requires=f"media_generation.music 段与千问AI平台的 API Key {QWEN_API_KEY_ENV}",
        )
    http_client = httpx.AsyncClient(follow_redirects=True)
    catalog_engine = _product_catalog_engine(settings.product_catalog, product_catalog_engine)
    owns_catalog_engine = catalog_engine is not None and product_catalog_engine is None
    if catalog_engine is None:
        _logger.warning("未配置产品资料库，爆款视频降级不可用，未命中的款一律返回 none")
    inspirations = build_inspirations_module(
        PgInspirationVideos(active_engine),
        PgStyleDirectory(catalog_engine) if catalog_engine is not None else NoStyleDirectory(),
    )
    workspace_store = PgFileStore(active_engine)
    live_connections = LiveConnections()
    announcing_workspace_store = AnnouncingFileStore(workspace_store, live_connections)

    material_ledger = PgMaterialLedger(active_engine)
    conversation_workspace = ConversationWorkspace(
        workspace_store, announcing_workspace_store, material_ledger
    )

    async def clear_conversation_completion(conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        await conversations.service.clear_completed(conversation_id, owner)

    async def conversation_readable(principal: Principal, conversation_id: uuid.UUID) -> bool:
        return await conversations.service.readable(principal, conversation_id)

    conversation_repo = SqlConversationRepository(active_engine)

    generation_repo = AnnouncingGenerationRepository(
        SqlGenerationRepository(active_engine), live_connections
    )
    settled_records = SettledRecords(generation_repo)

    connector: procrastinate.BaseConnector | None = None
    if settings.media_generation is not None or settings.iclip_studio is not None:
        connector = (
            queue_connector
            if queue_connector is not None
            else procrastinate.PsycopgConnector(conninfo=queue_dsn(settings.database_url))
        )

    if render_client is not None and settings.media_generation is None:
        raise RuntimeError("成片导出已启用却没开媒体生成；resolve_settings 应当已拒绝这种配置")
    generation: GenerationModule | None = None
    if settings.media_generation is not None:
        if public_objects is None:
            raise RuntimeError("媒体生成已启用却没有对象存储；resolve_settings 应当已拒绝这种配置")
        if connector is None:
            raise RuntimeError("媒体生成已启用却没建队列连接器；上面的条件漏了媒体生成")
        if codec is None or compose_concurrency is None:
            raise RuntimeError("媒体生成已启用却没选编解码；ffmpeg_required 应当已包含媒体生成")
        render: RenderSetup | None = None
        if render_client is not None:
            if server_uploads is None:
                raise RuntimeError("成片导出已启用却没有上传签名；注入的测试桶不支持成片导出")
            render = RenderSetup(
                client=render_client, uploads=server_uploads, public_url=public_objects.public_url
            )
        generation = _generation_module(
            settings.media_generation,
            generation_repo,
            act_as=identity.act_as,
            clear_completion=clear_conversation_completion,
            lineage=ForkLineageAdapter(
                conversations=conversation_repo, readable=conversation_readable
            ),
            object_store=public_objects,
            queue_connector=connector,
            media_codec=codec,
            compose_concurrency=compose_concurrency,
            fetch_url=fetch_url,
            render=render,
        )

    async def own_video_upload(principal: Principal, upload_id: uuid.UUID) -> str | None:
        try:
            job = await generation_repo.get(upload_id, owner=principal.user_id)
        except NotFound:
            return None
        if job.kind != KIND_VIDEO or job.operation != OPERATION_UPLOAD:
            return None
        return job.output.url

    brand_templates: BrandTemplatesModule | None = None
    if generation is not None:
        if public_objects is None:
            raise RuntimeError("品牌资源已启用却没有对象存储")
        brand_templates = build_brand_templates_module(
            SqlBrandTemplateStore(active_engine),
            objects=public_objects,
            probe_font=brand_font_probe or template_font_prober(http_client, fetch_url),
        )

    reference_store = SqlReferenceStore(active_engine)
    breakdown_setup: BreakdownSetup | None = None
    tagging_setup: TaggingSetup | None = None
    if settings.iclip_studio is not None and connector is not None:
        if codec is None or breakdown_concurrency is None:
            raise RuntimeError("拆解已启用却没选编解码；ffmpeg_required 应当已包含 iclip_studio")
        breakdown_setup = BreakdownSetup(
            breakdowns=reference_breakdowns
            or build_reference_breakdown(
                settings.iclip_studio, http_client, codec, fetch_url=fetch_url
            ),
            connector=connector,
            concurrency=breakdown_concurrency,
        )
        tagging_setup = TaggingSetup(
            tagger=library_tagger or build_library_tagger(settings.iclip_studio, http_client),
            connector=connector,
        )
    library_reports = PgLibraryReports(active_engine)
    hit_case_treatments = HitCaseTreatments(workspace_store)
    tagging = build_tagging_module(
        SqlTagStore(active_engine),
        source_text=LibrarySourceText(
            reference_store, library=library_reports, treatments=hit_case_treatments
        ),
        setup=tagging_setup,
    )
    references = build_references_module(
        reference_store,
        act_as=identity.act_as,
        own_video_upload=own_video_upload,
        breakdown=breakdown_setup,
        tagging=tagging.service,
        uploads_available=public_objects is not None,
        test_videos=GenerationTestVideos(
            generation_repo, generation.service if generation is not None else None
        ),
        testable=generation is not None,
    )

    step_store = PgStepStore(
        active_engine, max_snapshots_per_run=settings.agent_runs.max_snapshots_per_run
    )
    usage_ledger = UsageLedger(
        store=PgConversationUsage(active_engine), conversation_of=_conversation_of
    )
    collection_repo = SqlCollectionRepository(active_engine)
    collections = build_collections_module(collection_repo)

    async def list_owner_collections(owner: uuid.UUID, *, limit: int) -> tuple[CollectionInfo, ...]:
        found = await collection_repo.list_recent(owner=owner, limit=limit)
        return tuple(
            CollectionInfo(id=item.id, name=item.name, updated_at=item.updated_at) for item in found
        )

    def on_activity(conversation_id: str, owner: uuid.UUID, state: ActivityState) -> None:
        live_connections.announce_activity(
            owner,
            uuid.UUID(conversation_id),
            busy=state.busy,
            pending_interaction=state.pending_interaction,
            last_turn_reason=state.last_turn_reason,
        )

    job_queue = JobQueue(active_engine, on_activity=on_activity)

    async def activities_of(
        conversation_ids: Sequence[uuid.UUID],
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        states = await job_queue.activities([str(one) for one in conversation_ids])
        videos = (
            await generation.service.in_flight_by_conversation(conversation_ids, kind=KIND_VIDEO)
            if generation is not None
            else {}
        )
        return {
            one: ConversationActivity(
                busy=state.busy,
                pending_interaction=state.pending_interaction,
                last_turn_reason=state.last_turn_reason,
                video_generation=videos.get(one, "none"),
            )
            for one, state in ((one, states[str(one)]) for one in conversation_ids)
        }

    async def busy_conversation_ids(owner: uuid.UUID | None) -> frozenset[uuid.UUID]:
        return frozenset(uuid.UUID(one) for one in await job_queue.busy_conversation_ids(owner))

    async def latest_master_urls(conversation_ids: Sequence[uuid.UUID]) -> Mapping[uuid.UUID, str]:
        if generation is None:
            return {}
        return await generation.service.latest_master_by_conversation(conversation_ids)

    async def user_principal(user_id: uuid.UUID) -> Principal:
        """按账号当下的角色重建用户主体；账号不存在抛 NotFound，已停用抛 AuthenticationFailed。"""

        return identity.service.principal_for_user(await identity.service.get_account(user_id))

    plugins = build_plugin_registry(
        workspace_store=announcing_workspace_store,
        material_ledger=material_ledger,
        http_client=http_client,
        fetch_url=fetch_url,
        resolve_principal=user_principal,
        generation_service=generation.service if generation is not None else None,
        settled_records=settled_records,
        image_models=generation.image_models if generation is not None else frozenset(),
        object_store=public_objects,
        video=settings.video,
        shot_video=settings.shot_video if settings.shot_tools_enabled else None,
        iclip_studio=settings.iclip_studio,
        reference_service=references.service if references.queue is not None else None,
        media_codec=codec,
    )
    tool_displays = build_display_registry(plugins)
    transcript_store = TranscriptStore()

    transcript_history = TranscriptHistory(step_store, job_queue, tool_displays, DELEGATE_TOOL)

    tasks = build_tasks_module(SqlTaskRepository(active_engine), act_as=identity.act_as)
    tracking = build_tracking_module(SqlTrackingRepository(active_engine))
    # agent 配置与技能库、模型供应商互相要用：那两边经端口问 agent 表「谁在用」，agent 配置经端口查它们。
    # 先建 agent 的仓储交给那两边，再用它们的服务装 agent 配置。
    agent_store = SqlAgentStore(active_engine)
    agent_references = AgentReferences(agent_store)
    skills = build_skills_module(SqlSkillStore(active_engine), usages=agent_references)
    provider_declarations = load_declarations()
    require_known_providers(provider_declarations)
    model_providers = build_model_providers_module(
        SqlModelProviderStore(active_engine),
        declarations=provider_declarations,
        cipher=CredentialCipher(settings.credential_encryption_keys),
        probe=credential_probe if credential_probe is not None else PydanticAiCredentialProbe(),
        usages=agent_references,
    )
    agent_config = build_agent_config_module(
        agent_store,
        models=ProviderDirectory(model_providers.service),
        plugins=RegistryPluginDirectory(plugins),
        skills=LibrarySkillDirectory(skills.service),
    )
    sessions = PgSessionStore(active_engine)
    agent_runtime = AgentRuntime(
        agent_config=agent_config.service,
        skills=skills.service,
        model_providers=model_providers.service,
        sessions=sessions,
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
    audit = build_audit_module(PgAuditReports(active_engine))
    same_style = SameStyleCopier(store=workspace_store, ledger=material_ledger)
    library = build_library_module(
        library_reports,
        has_production_files=same_style.has_production_files,
        tagging=tagging.service,
        has_treatment=hit_case_treatments.exists,
    )
    conversations = build_conversations_module(
        conversation_repo,
        act_as=identity.act_as,
        list_agents=agent_runtime.directory,
        open_session=agent_runtime.open_session,
        fork_session=agent_runtime.fork_session,
        list_collections=list_owner_collections,
        claim_task=tasks.service.claim,
        list_derived_files=conversation_workspace.list_files,
        read_derived_file=conversation_workspace.read_file,
        write_derived_file=conversation_workspace.write_file,
        document_validators={
            SHOTS_PATH: validate_video_shots,
            FILM_PATH: validate_film,
            RUN_PATH: validate_film_run,
        },
        film=ConversationFilmAdapter(
            store=workspace_store,
            announcing=announcing_workspace_store,
            ledger=material_ledger,
            generation=generation.service if generation is not None else None,
        ),
        drafts=SqlWholeFilmDraftStore(active_engine),
        draft_references=GenerationDraftReferences(
            generations=generation_repo, conversations=conversation_repo
        ),
        exports=None
        if render_client is None or generation is None
        else WholeFilmExportAdapter(
            generation=generation.service, generations=generation_repo, render=render_client
        ),
        generate_title=agent_runtime.generate_title,
        announce_title=live_connections.announce_title,
        event_watermark=live_connections.clock.snapshot,
        announce_row=live_connections.announce_session_row,
        announce_deleted=live_connections.announce_session_deleted,
        activities_of=activities_of,
        busy_conversation_ids=busy_conversation_ids,
        latest_master_urls=latest_master_urls,
        fork_transcript=ForkTranscriptAdapter(queue=job_queue, history=transcript_history),
        copy_workspace=WorkspaceCopier(store=workspace_store, ledger=material_ledger),
        copy_same_style=same_style,
        same_style_source=LibrarySameStyleSource(library_reports),
    )
    uploads: UploadsModule | None = None
    owned_fetcher: PublicFetcher | None = None
    if public_objects is not None:
        if image_fetcher is None:
            owned_fetcher = PublicFetcher()
            image_fetcher = owned_fetcher.fetch
        uploads = build_uploads_module(
            public_objects,
            act_as=identity.act_as,
            record=settled_records.record_upload,
            find_recorded=settled_records.recorded_upload,
            fetch=image_fetcher,
            conversation_writable=conversations.service.workspace_writable,
        )

    async def name_conversation(row: JobRow) -> None:
        try:
            await conversations.service.name_at_turn_start(uuid.UUID(row.conversation_id), row.text)
        except NotFound:
            _logger.info("对话已删除，跳过自动起名", conversation_id=row.conversation_id)

    async def note_run_started(row: JobRow, run_id: str) -> None:
        try:
            await conversations.service.begin_run(
                owner=row.owner_user_id,
                agent_id=row.agent_id,
                conversation_id=row.conversation_id,
                run_id=run_id,
            )
        except NotFound:
            _logger.info(
                "对话已删除，这次运行不再记到对话上",
                conversation_id=row.conversation_id,
                run_id=run_id,
            )

    async def deps_for_prompt(row: JobRow) -> AgentRunDeps:
        # 开跑闸门：属主账号不存在或已停用，这次运行在这里失败。
        await user_principal(row.owner_user_id)
        return AgentRunDeps(
            user_id=row.owner_user_id,
            conversation_id=row.conversation_id,
            user_name=row.user_name,
        )

    transcripts = TranscriptService(
        store=transcript_store,
        history=transcript_history,
        queue=job_queue,
        record_materials=conversation_workspace.record_materials,
        runner=ConversationRunner(
            agents=agent_runtime,
            store=transcript_store,
            queue=job_queue,
            snapshots=step_store,
            history=transcript_history,
            deps_for=deps_for_prompt,
            heartbeat_seconds=settings.agent_runs.heartbeat_seconds,
            lease_seconds=settings.agent_runs.lease_seconds,
            sweep_seconds=settings.agent_runs.sweep_seconds,
            max_attempts=settings.agent_runs.max_attempts,
            compaction_max_fraction=settings.compaction.max_fraction,
            compaction_keep_messages=settings.compaction.keep_messages,
            on_turn_started=name_conversation,
            on_run_started=note_run_started,
            display=tool_displays,
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        await transcripts.runner.start()
        if connector is not None:
            await connector.open_async()
        if generation is not None:
            generation.queue.start()
        if references.queue is not None:
            references.queue.start()
        if tagging.queue is not None:
            tagging.queue.start()
        try:
            yield
        finally:
            if tagging.queue is not None:
                await tagging.queue.stop()
            if references.queue is not None:
                await references.queue.stop()
            if generation is not None:
                await generation.queue.stop()
            if connector is not None:
                await connector.close_async()
            await transcripts.runner.shutdown()
            await http_client.aclose()
            if render_client is not None:
                await render_client.aclose()
            if owned_fetcher is not None:
                await owned_fetcher.aclose()
            if owns_catalog_engine and catalog_engine is not None:
                await catalog_engine.dispose()
            if owns_engine:
                await active_engine.dispose()

    app = FastAPI(title=settings.app_name, lifespan=lifespan)

    install_error_handlers(app)

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"status": "ok"}

    for router in identity.routers:
        app.include_router(router)
    for router in generation.routers if generation is not None else ():
        app.include_router(router)
    for router in uploads.routers if uploads is not None else ():
        app.include_router(router)
    for router in inspirations.routers:
        app.include_router(router)
    for router in conversations.routers:
        app.include_router(router)
    for router in collections.routers:
        app.include_router(router)
    for router in tasks.routers:
        app.include_router(router)
    for router in audit.routers:
        app.include_router(router)
    for router in library.routers:
        app.include_router(router)
    for router in references.routers:
        app.include_router(router)
    for router in tagging.routers:
        app.include_router(router)
    if brand_templates is not None:
        for router in brand_templates.routers:
            app.include_router(router)
    for router in tracking.routers:
        app.include_router(router)
    for router in skills.routers:
        app.include_router(router)
    for router in model_providers.routers:
        app.include_router(router)
    for router in agent_config.routers:
        app.include_router(router)
    app.include_router(
        create_transcript_router(
            transcripts,
            conversations.service,
            act_as=identity.act_as,
            allowed_origins=settings.security.cors_allow_origins,
            live=live_connections,
            import_attachments=(
                PromptAttachmentImporter(uploads.service.import_image)
                if uploads is not None
                else None
            ),
        )
    )

    # Starlette 里后加的中间件在外层；CORS 要在最外层，preflight 不带凭证也得被它应答。
    app.add_middleware(PrincipalMiddleware, resolver=identity.resolver)
    if settings.security.cors_allow_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.security.cors_allow_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.state.agent_services = AgentServices(
        skills=skills.service,
        model_providers=model_providers.service,
        agent_config=agent_config.service,
        sessions=sessions,
        runtime=agent_runtime,
    )
    # 集成测试经它直接调生成队列的任务协程，不起 worker。
    app.state.generation = generation
    return app


__all__ = ["AgentServices", "build_app"]
