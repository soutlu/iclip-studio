"""对话生命周期、访问控制与派生文件操作。对话 id 由服务端生成。"""

from __future__ import annotations

import asyncio
import uuid
import weakref
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

import structlog
from agent_runtime.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip_video.film_view import FilmImagePrompt, FilmTextEdit, FilmView

from iclip.domains.conversations.models import (
    IDLE_ACTIVITY,
    AgentPreview,
    Conversation,
    ConversationActivity,
    PreviewHeader,
    VideoPhase,
    WholeFilmDraft,
    WholeFilmExport,
)
from iclip.domains.conversations.repository import (
    MISSING_COLLECTION,
    MISSING_TASK,
    AgentPreviewStore,
    AuditFilter,
    ConversationRepository,
    DeletedFilter,
    PageCursor,
    StateFilter,
    WholeFilmDraftStore,
)
from iclip.domains.conversations.schemas import DEFAULT_TITLE, MAX_TITLE_CHARS, conversation_out
from iclip.domains.conversations.whole_film_schemas import WholeFilmDocument
from iclip.domains.identity.public import (
    AGENT_MANAGE_PERMISSION,
    MANAGE_PERMISSION,
    Principal,
    visible_owner_incl_act_as,
)
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor

_logger = structlog.stdlib.get_logger(__name__)

SIDEBAR_COLLECTIONS = 100
"""侧栏最多带几个合集：只取最近建立的这些，更早的连同其中的对话不在侧栏里。"""
SIDEBAR_UNGROUPED = 20
SIDEBAR_PER_COLLECTION = 10

ListState = Literal["all", "running", "done", "open"]
"""列表状态筛选：``done`` / ``open`` 看属主标没标收尾，两者互补；``running`` 是此刻占着的那几段。"""


@dataclass(frozen=True, slots=True)
class AgentEntry:
    """可发起对话的一个顶层 Agent；``name`` 是给人看的名字。"""

    id: str
    name: str


@dataclass(frozen=True, slots=True)
class AgentDirectory:
    """首页能选的顶层 Agent 名册，按配置里的先后；``default`` 为空即目录是空的。"""

    items: tuple[AgentEntry, ...]
    default: str | None


ListAgents = Callable[[], Awaitable[AgentDirectory]]
"""读当前名册，由组合根接到 agent 配置；每次调都是库里此刻的一份。"""


class RuntimeSessions(Protocol):
    """运行时那一侧的会话操作，由组合根接到运行时的会话服务上。会话 id 等于对话 id，``*_user`` 是两端
    对话的属主。对话行由用例在这些都做完之后才落：中途失败只留下寻址不到的数据。"""

    async def open(self, session_id: uuid.UUID, *, agent_id: str) -> None:
        """给新对话开会话，固定这个 agent 此刻的当前版本。

        没有这个 agent、或它不上首页菜单是 ``ValidationFailed``；已归档、还没发布过是 ``Conflict``。"""
        ...

    async def open_preview(
        self, session_id: uuid.UUID, *, agent_id: str, version_id: uuid.UUID | None
    ) -> None:
        """开一段预览会话：``version_id`` 为空每次运行装这个 agent 当下的草稿，否则固定那一版；不看上不上
        菜单、在不在用、发没发布过。没有这个 agent 是 ``NotFound``，版本不是它的是 ``ValidationFailed``。"""
        ...

    async def fork(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None:
        """从源对话的第 ``turn`` 轮分叉：开会话、拷工作区文件与整份素材台账、写种子快照。

        ``agent_id`` 为 None 照抄源会话的版本，否则按 ``open`` 固定那个 agent 并照它抛错。源有没跑完的
        消息、或数完轮数后轮数又变了是 ``Conflict``；源没跑过或 ``turn`` 超出轮数是 ``ValidationFailed``。
        这些拒绝都在写任何东西之前。"""
        ...

    async def copy_files(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool:
        """按（源路径，目标路径）清单拷几份文件进目标对话的工作区，连同整份素材台账；源里没有的跳过。
        ``require_any`` 一个都不在时什么都不写、回 ``False``。"""
        ...


ActivitiesOf = Callable[[Sequence[uuid.UUID]], Awaitable[Mapping[uuid.UUID, ConversationActivity]]]
"""批量读取引擎侧活动信息，由组合根注入；未返回的 id 使用 IDLE_ACTIVITY。"""

BusyConversationIds = Callable[[uuid.UUID | None], Awaitable[frozenset[uuid.UUID]]]
"""此刻在跑（含等审批）的对话 id；给属主就按属主算，给 None 算全平台。"""

LatestMasterUrls = Callable[[Sequence[uuid.UUID]], Awaitable[Mapping[uuid.UUID, str]]]
"""批量读这些对话各自名下最新一条素材片的地址（不含分叉继承来的），由组合根注入；没有素材片的 id 不在结果里。"""

VideoProgressOf = Callable[[uuid.UUID | None], Awaitable[Mapping[uuid.UUID, VideoPhase]]]
"""还有视频记录没跑完的对话各到哪一步，由组合根接到生成域；给属主只看他名下的记录，给 None 看全平台。
一条都没有的对话不在结果里。"""

GenerateTitle = Callable[[str], Awaitable[str | None]]
"""由组合根注入的标题生成器；返回 None 表示本次不生成标题。"""

AnnounceTitle = Callable[[uuid.UUID, uuid.UUID, str], None]
"""同步广播标题更新，参数为 (属主, 对话 id, 标题)。

广播不依赖对话订阅，发给属主与治理者的连接；仅写入出站队列，不等待回执。"""

AnnounceConversationRow = Callable[
    [Literal["created", "updated"], uuid.UUID, uuid.UUID, Mapping[str, Any]], None
]
"""同步广播新出现或变化了的整行，参数为 (种类, 属主, 对话 id, camelCase 整行)。

在提交之后调用，与标题广播同一投递范围。"""

AnnounceConversationDeleted = Callable[[uuid.UUID, uuid.UUID], None]
"""同步广播属主删掉了一段对话，参数为 (属主, 对话 id)；写入提交之后调用。"""


@dataclass(frozen=True, slots=True)
class DerivedFile:
    """对话工作区文件元信息。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class DerivedFileContent:
    """工作区文件内容与版本。"""

    path: str
    content: str
    version: int


@dataclass(frozen=True, slots=True)
class CollectionInfo:
    """侧栏合集元信息。"""

    id: uuid.UUID
    name: str
    updated_at: datetime


class ListCollections(Protocol):
    """按建立时间倒序读取属主最近建立的至多 ``limit`` 个合集元信息；实现由组合根注入。"""

    async def __call__(self, owner: uuid.UUID, *, limit: int) -> Sequence[CollectionInfo]: ...


ClaimTask = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]
"""对话挂上需求单就是有人在做了：以 (需求单 id, 对话属主) 认领它。实现由组合根注入。"""

TaskExists = Callable[[uuid.UUID], Awaitable[bool]]
"""有没有这张需求单，不看状态与创建者，与对话行上的外键同一口径。实现由组合根注入。"""

CollectionExists = Callable[[uuid.UUID], Awaitable[bool]]
"""有没有这个合集，不看属主，与对话行上的外键同一口径。实现由组合根注入。"""


@dataclass(frozen=True, slots=True)
class SameStyleFiles:
    """做同款拷哪几份文件，由组合根给：``files`` 是（源路径，新对话里的路径），``require_any`` 里一份都
    没有的对话做不了同款。"""

    files: tuple[tuple[str, str], ...]
    require_any: frozenset[str]


class SameStyleSource(Protocol):
    """做同款认源：资料库里这张卡挂着的对话的属主。

    挂着对话的卡，卡 id 就是对话 id。不是资料库卡、或卡不挂对话时给 ``None``；不看那段对话
    删没删。"""

    async def __call__(self, card_id: uuid.UUID) -> uuid.UUID | None: ...


ListDerivedFiles = Callable[[uuid.UUID, uuid.UUID], Awaitable[Sequence[DerivedFile]]]
"""列出工作区文件，参数为 (属主, 对话 id)。"""

ReadDerivedFile = Callable[[uuid.UUID, uuid.UUID, str], Awaitable[DerivedFileContent | None]]
"""读取工作区文件，参数为 (属主, 对话 id, 路径)；不存在时返回 None。
路径语法由存储实现校验，非法路径抛 ValidationFailed。"""

WriteDerivedFile = Callable[[uuid.UUID, uuid.UUID, str, str, int], Awaitable[DerivedFileContent]]
"""覆盖工作区文件，参数为 (属主, 对话 id, 路径, 正文, 期望版本)。
版本不匹配抛 Conflict；路径和容量由存储实现校验。"""


class ConversationFilm(Protocol):
    """这段对话里 AI 导演的工程，在制作页上读、改字、换图；由组合根接到工作区文件与生成记录上。

    ``owner`` 是对话属主，权限由用例先判。版本对不上抛 Conflict，改动不合规矩抛
    ValidationFailed，消息是给人看的一句话。"""

    async def view(
        self, principal: Principal, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> FilmView | None:
        """没有工程文件返回 None。"""
        ...

    async def edit_text(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        edits: Sequence[FilmTextEdit],
        *,
        film_version: int,
    ) -> FilmView: ...

    async def choose_image(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        node: str,
        url: str | None,
        film_version: int,
        run_version: int | None,
    ) -> FilmView: ...

    async def set_aspect_ratio(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        aspect_ratio: str,
        film_version: int,
    ) -> FilmView:
        """把所有视频与机位图的画幅改成 ``aspect_ratio``；本来就是它时不写文件。"""
        ...

    async def generate_image(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        node: str,
        prompt: FilmImagePrompt | None,
        film_version: int,
        run_version: int | None,
    ) -> uuid.UUID:
        """按描述给一张图出一张新的，返回生成任务 id。``prompt`` 为 None 用文件里的描述。"""
        ...

    async def generate_video(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        video: str,
        model: str,
        resolution: str,
        generate_audio: bool,
        film_version: int,
        run_version: int | None,
    ) -> uuid.UUID:
        """给一个镜头组出片，返回生成任务 id。"""
        ...


class WholeFilmDraftReferences(Protocol):
    """保存成片草稿前核对它引用的生成记录，由组合根接到生成记录上。

    画面轨的每段要出自这段对话自己的或继承来的一条素材片，音乐要是这段对话的一条已完成的音频记录，
    改字的字幕记录要是这段对话自己的或继承来的一条素材片的字幕。不合格抛 ValidationFailed，消息是
    给人看的一句话，不区分「没有这条」与「不是这段对话的」。"""

    async def __call__(
        self, principal: Principal, conversation_id: uuid.UUID, document: WholeFilmDocument
    ) -> None: ...


class WholeFilmRenderUnavailable(Exception):
    """渲染服务连不上、答 5xx 或答复看不懂；入口按上游不可用答 502。"""


class WholeFilmExports(Protocol):
    """成片导出，由组合根接到生成记录与渲染服务上：每次导出是一条成片生成记录，由生成队列交给
    渲染服务。归属（属主、这段对话）由用例核对过才调进来。"""

    async def start(
        self,
        principal: Principal,
        *,
        conversation_id: uuid.UUID,
        revision: int,
        document: WholeFilmDocument,
    ) -> uuid.UUID:
        """记下这次导出要的素材片、音乐与字幕，建一条成片生成记录排队，返回它的 id。

        用到的记录没有产物地址抛 ValidationFailed。"""
        ...

    async def latest(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID
    ) -> WholeFilmExport | None:
        """这段对话、这个属主最新的一次导出；一次都没有给 None。"""
        ...

    async def cancel(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID, export_id: uuid.UUID
    ) -> None:
        """取消一次导出。不是这段对话、这个属主的成片导出抛 NotFound；正在交给渲染服务抛
        Conflict；渲染服务连不上抛 ``WholeFilmRenderUnavailable``；已结束的不改。"""
        ...


_EXPORTS_OFF = "成片导出没有开通"


class WorkspaceDocumentValidator(Protocol):
    """工作区文件写入前的校验协议，由组合根按路径注入。

    校验实现与文件生产方共用规则；失败抛 ValidationFailed，消息返回调用方。"""

    async def __call__(
        self, owner: uuid.UUID, conversation_id: uuid.UUID, content: str
    ) -> None: ...


def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _fork_title(source_title: str, turn: int) -> str:
    """副本的默认名字：源标题加一个说明血缘的后缀，超长时截源标题那一半。"""

    suffix = f"（分叉 · 第 {turn} 轮）"
    return source_title[: MAX_TITLE_CHARS - len(suffix)] + suffix


def _as_conversation_id(raw: str) -> uuid.UUID:
    """把字符串形态的对话 id 解析成 UUID，解析不了统一抛 NotFound。

    入口层（REST 路径参数与 WS 帧）已经把两种写法规范化，工作区与实时状态只见到一种拼写；
    这里只负责字符串到 UUID 的交接，不再复校一遍写法。"""

    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise NotFound("没有这段对话") from exc


@dataclass(frozen=True, slots=True)
class ConversationPage:
    """一页对话。``next_cursor`` 为空即没有更多了。"""

    items: tuple[Conversation, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class AuditPage:
    """审计的一页，外加两个不随翻页变的真总数：当前筛选下共几段、同一范围内此刻几段在跑。"""

    items: tuple[Conversation, ...]
    next_cursor: str | None
    total: int
    running_total: int
    latest_master_urls: Mapping[uuid.UUID, str]
    """这一页里各段对话自己名下最新一条素材片的地址；没有素材片的不在里面。"""


@dataclass(frozen=True, slots=True)
class SidebarGroup:
    """侧栏里的一个合集：元信息、筛选下的对话总数与第一页。"""

    collection: CollectionInfo
    total: int
    page: ConversationPage


@dataclass(frozen=True, slots=True)
class Sidebar:
    """侧栏一屏：合集分组（空合集也在）、未分组的总数与第一页，以及这些页里每段对话的活动状态。"""

    groups: tuple[SidebarGroup, ...]
    ungrouped_total: int
    ungrouped: ConversationPage
    activities: Mapping[uuid.UUID, ConversationActivity]


def _page(items: tuple[Conversation, ...], *, limit: int) -> ConversationPage:
    """满页时生成下一页游标，避免额外查询；最后一页恰好满额时允许下一页为空。"""

    last = items[-1] if len(items) == limit else None
    return ConversationPage(
        items=items,
        next_cursor=None if last is None else encode_cursor(last.created_at, last.id),
    )


def _after(cursor: str | None) -> PageCursor | None:
    """把游标还原成仓库的排序键；``None`` 即从头取。"""

    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return PageCursor(created_at=parsed.at, conversation_id=parsed.uuid_key())


class ConversationService:
    """对话生命周期、查询与工作区用例。"""

    def __init__(
        self,
        repo: ConversationRepository,
        *,
        previews: AgentPreviewStore,
        runtime: RuntimeSessions,
        list_collections: ListCollections,
        claim_task: ClaimTask,
        task_exists: TaskExists,
        collection_exists: CollectionExists,
        list_derived_files: ListDerivedFiles,
        read_derived_file: ReadDerivedFile,
        write_derived_file: WriteDerivedFile,
        document_validators: Mapping[str, WorkspaceDocumentValidator],
        film: ConversationFilm,
        drafts: WholeFilmDraftStore,
        draft_references: WholeFilmDraftReferences,
        exports: WholeFilmExports | None,
        generate_title: GenerateTitle,
        announce_title: AnnounceTitle,
        activities_of: ActivitiesOf,
        busy_conversation_ids: BusyConversationIds,
        latest_master_urls: LatestMasterUrls,
        video_progress_of: VideoProgressOf,
        same_style_files: SameStyleFiles,
        same_style_source: SameStyleSource,
        announce_row: AnnounceConversationRow,
        announce_deleted: AnnounceConversationDeleted,
    ) -> None:
        self._repo = repo
        self._previews = previews
        self._runtime = runtime
        self._drafts = drafts
        self._draft_references = draft_references
        self._exports = exports
        self._same_style_files = same_style_files
        self._same_style_source = same_style_source
        self._announce_row = announce_row
        self._announce_deleted = announce_deleted
        self._claim_task = claim_task
        self._task_exists = task_exists
        self._collection_exists = collection_exists
        self._activities_of = activities_of
        self._busy_conversation_ids = busy_conversation_ids
        self._latest_master_urls = latest_master_urls
        self._video_progress_of = video_progress_of
        self._generate_title = generate_title
        self._announce_title = announce_title
        self._list_collections = list_collections
        self._list_derived_files = list_derived_files
        self._read_derived_file = read_derived_file
        self._write_derived_file = write_derived_file
        self._document_validators = document_validators
        self._film = film
        # 同一段对话的「写库 → 读活动 → 广播」在本进程串行：帧按到达先后生效，所以广播顺序必须等于提交
        # 顺序。两次写入若在读活动处交错，先提交的旧行会晚一步广播，把新行盖回去。锁只经 _row_lock 用在
        # async with 里，没人持有也没人等待时随即回收。
        self._row_locks: weakref.WeakValueDictionary[uuid.UUID, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )

    def _row_lock(self, conversation_id: uuid.UUID) -> asyncio.Lock:
        lock = self._row_locks.get(conversation_id)
        if lock is None:
            lock = asyncio.Lock()
            self._row_locks[conversation_id] = lock
        return lock

    async def _broadcast_row(
        self,
        kind: Literal["created", "updated"],
        conversation: Conversation,
        *,
        activity: ConversationActivity | None = None,
    ) -> None:
        """把写入之后的整行广播出去。别处也能写到的对话要在行锁里调，广播顺序才等于提交顺序；分叉出的副本
        id 刚由服务端铸出，不用锁。调用方已有活动就传 ``activity``，不再去读。"""

        if activity is None:
            activity = (await self.activities([conversation.id]))[conversation.id]
        row = conversation_out(conversation, activity).model_dump(mode="json", by_alias=True)
        self._announce_row(kind, conversation.owner_user_id, conversation.id, row)

    async def activities(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        """返回每个请求 id 的活动状态；缺失信息按 IDLE_ACTIVITY 补齐。"""

        known = await self._activities_of(conversation_ids)
        return {one: known.get(one, IDLE_ACTIVITY) for one in conversation_ids}

    async def _readable(self, principal: Principal, conversation_id: uuid.UUID) -> Conversation:
        """读路径的可见范围：治理者读得到所有人的对话，含属主已删的墓碑；替人办事的钥匙
        读得到所有人活着的对话；其他人只见自己活着的。"""

        if principal.has(MANAGE_PERMISSION):
            return await self._repo.get(conversation_id, owner=None, include_deleted=True)
        return await self._repo.get(conversation_id, owner=visible_owner_incl_act_as(principal))

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        """主体读不读得到这段对话，口径同其他读路径；给别的域判「读得到才放开」用。"""

        try:
            await self._readable(principal, conversation_id)
        except NotFound:
            return False
        return True

    async def _session(
        self, principal: Principal, conversation_id: uuid.UUID, *, writing: bool
    ) -> Conversation | AgentPreview:
        """transcript、订阅与读工作区文件认的那段会话：对话，或 agent 测试预览。谁能用都只在这里判。

        对话照原来的口径：读按 ``_readable``，写只限属主活着的对话。不是看得见的对话时再认预览：只有它的
        属主本人、且此刻持 ``agent:manage`` 才认，读写一样，治理者也不例外；其余一律 ``NotFound``，不泄露
        这个 id 是对话还是预览。"""

        try:
            if writing:
                return await self._repo.get(conversation_id, owner=principal.user_id)
            return await self._readable(principal, conversation_id)
        except NotFound:
            preview = await self._previews.get(conversation_id)
            if (
                preview is None
                or preview.owner_user_id != principal.user_id
                or not principal.has(AGENT_MANAGE_PERMISSION)
            ):
                raise
            return preview

    async def files(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Sequence[DerivedFile]:
        """列出可见对话的工作区文件；治理者可跨属主读取。预览的工作区只有它的属主读得到（见 ``_session``）。"""

        session = await self._session(principal, conversation_id, writing=False)
        return await self._list_derived_files(session.owner_user_id, session.id)

    async def file(
        self, principal: Principal, conversation_id: uuid.UUID, *, path: str
    ) -> DerivedFileContent:
        """读取工作区文件；不可见对话或不存在的文件均返回 404。预览同 ``files``。"""

        session = await self._session(principal, conversation_id, writing=False)
        found = await self._read_derived_file(session.owner_user_id, session.id, path)
        if found is None:
            raise NotFound("这段对话里没有这个文件")
        return found

    async def write_file(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        path: str,
        content: str,
        expected_version: int,
    ) -> DerivedFileContent:
        """覆盖属主的工作区文件。不可见对话返回 404，可见但非属主返回 403。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        validate = self._document_validators.get(path)
        if validate is not None:
            await validate(conversation.owner_user_id, conversation.id, content)
        return await self._write_derived_file(
            conversation.owner_user_id, conversation.id, path, content, expected_version
        )

    async def film(self, principal: Principal, conversation_id: uuid.UUID) -> FilmView:
        """读这段对话的制作页；可见范围同读工作区文件，没有工程文件返回 404。"""

        conversation = await self._readable(principal, conversation_id)
        found = await self._film.view(principal, conversation.owner_user_id, conversation.id)
        if found is None:
            raise NotFound("这段对话里没有 AI 导演写的分镜")
        return found

    async def edit_film_text(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        edits: Sequence[FilmTextEdit],
        *,
        film_version: int,
    ) -> FilmView:
        """在制作页上改字；只有属主能改，口径同覆盖工作区文件。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._film.edit_text(
            principal,
            conversation.owner_user_id,
            conversation.id,
            edits,
            film_version=film_version,
        )

    async def choose_film_image(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        node: str,
        url: str | None,
        film_version: int,
        run_version: int | None,
    ) -> FilmView:
        """在制作页上给一张图换地址；只有属主能换，口径同覆盖工作区文件。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._film.choose_image(
            principal,
            conversation.owner_user_id,
            conversation.id,
            node=node,
            url=url,
            film_version=film_version,
            run_version=run_version,
        )

    async def set_film_aspect_ratio(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        aspect_ratio: str,
        film_version: int,
    ) -> FilmView:
        """在制作页上改整份工程的画幅；只有属主能改，口径同覆盖工作区文件。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._film.set_aspect_ratio(
            principal,
            conversation.owner_user_id,
            conversation.id,
            aspect_ratio=aspect_ratio,
            film_version=film_version,
        )

    async def generate_film_image(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        node: str,
        prompt: FilmImagePrompt | None,
        film_version: int,
        run_version: int | None,
    ) -> uuid.UUID:
        """在制作页上按描述生成一张图；要花钱，只有属主能发，口径同覆盖工作区文件。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._film.generate_image(
            principal,
            conversation.owner_user_id,
            conversation.id,
            node=node,
            prompt=prompt,
            film_version=film_version,
            run_version=run_version,
        )

    async def generate_film_video(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        video: str,
        model: str,
        resolution: str,
        generate_audio: bool,
        film_version: int,
        run_version: int | None,
    ) -> uuid.UUID:
        """在制作页上给一个镜头组出片；只有属主能发，口径同覆盖工作区文件。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._film.generate_video(
            principal,
            conversation.owner_user_id,
            conversation.id,
            video=video,
            model=model,
            resolution=resolution,
            generate_audio=generate_audio,
            film_version=film_version,
            run_version=run_version,
        )

    async def whole_film_draft(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> tuple[WholeFilmDraft, WholeFilmDocument] | None:
        """读这段对话的成片草稿与解析好的文档；可见范围同读工作区文件，还没存过返回 None。"""

        conversation = await self._readable(principal, conversation_id)
        found = await self._drafts.get(conversation.id)
        if found is None:
            return None
        return found, WholeFilmDocument.model_validate(found.document)

    async def save_whole_film_draft(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        revision: int,
        document: WholeFilmDocument,
    ) -> WholeFilmDraft:
        """整份覆盖成片草稿；只有属主能存，口径同覆盖工作区文件。

        ``revision`` 是读到的那一版（还没有草稿是 0），对不上是 409；引用的记录不合格是 422。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        await self._draft_references(principal, conversation.id, document)
        saved = await self._drafts.save(
            conversation.id,
            document=document.model_dump(mode="json", by_alias=True),
            revision=revision,
            updated_by=principal.user_id,
        )
        if saved is None:
            raise Conflict("成片草稿已经有更新的一版，重新读取后再改")
        return saved

    async def export_whole_film(
        self, principal: Principal, conversation_id: uuid.UUID, *, revision: int
    ) -> tuple[uuid.UUID, tuple[uuid.UUID, ...]]:
        """按当前草稿导出一条成片，返回导出 id 与用到的素材片（去重，按第一次出现的先后）。

        只有属主能导，口径同存草稿；``revision`` 不是存着的那一版是 409，画面轨是空的是 422。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        exports = self._require_exports()
        found = await self._drafts.get(conversation.id)
        if (found.revision if found is not None else 0) != revision:
            raise Conflict("成片草稿已经有更新的一版，重新读取后再导出")
        document = None if found is None else WholeFilmDocument.model_validate(found.document)
        if document is None or not document.layer0:
            raise ValidationFailed("画面轨里还没有内容，导不出成片")
        export_id = await exports.start(
            principal, conversation_id=conversation.id, revision=revision, document=document
        )
        return export_id, document.video_sources()

    async def latest_whole_film_export(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> WholeFilmExport | None:
        """这段对话最新的一次导出；导出归导出的人，只有属主能看，继承来的不算。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._require_exports().latest(
            conversation_id=conversation.id, owner_user_id=conversation.owner_user_id
        )

    async def cancel_whole_film_export(
        self, principal: Principal, conversation_id: uuid.UUID, export_id: uuid.UUID
    ) -> None:
        """取消一次导出；别的对话、别人的导出 id 取消不了（404）。"""

        conversation = await self._workspace_writable(principal, conversation_id)
        await self._require_exports().cancel(
            conversation_id=conversation.id,
            owner_user_id=conversation.owner_user_id,
            export_id=export_id,
        )

    def _require_exports(self) -> WholeFilmExports:
        if self._exports is None:
            raise ValidationFailed(_EXPORTS_OFF)
        return self._exports

    async def workspace_writable(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Conversation:
        """主体能不能改这段对话，口径同改工作区文件；给别的域判「属主才能挂到这段对话」用。"""

        return await self._workspace_writable(principal, conversation_id)

    async def _workspace_writable(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Conversation:
        """改工作区的权限：看不见是 404，看得见但不是属主是 403。"""

        conversation = await self._readable(principal, conversation_id)
        if conversation.owner_user_id != principal.user_id:
            raise PermissionDenied("只有属主能改这段对话")
        # 治理者读得到自己删掉的对话，但墓碑对谁都是只读的。
        if conversation.deleted_at is not None:
            raise PermissionDenied("已删除的对话不能再改")
        return conversation

    async def create(
        self,
        principal: Principal,
        *,
        agent_id: str,
        conversation_id: uuid.UUID | None = None,
        title: str | None = None,
        task_id: uuid.UUID | None = None,
        collection_id: uuid.UUID | None = None,
        same_as: uuid.UUID | None = None,
    ) -> tuple[Conversation, bool]:
        """创建一段对话，返回它与「本次是否新建」。

        ``conversation_id`` 由调用方铸时按它幂等：重发同一个 id 返回已有那一段。
        落库的那一段挂着需求单，就以它的属主认领那张单，重发也认领一次。

        新建时先查给的需求单与合集在不在，不在抛 ``ValidationFailed``，运行时什么都不写；外键约束仍兜底。
        再在运行时开会话、固定 agent 此刻的当前版本，agent 不能开对话时按 ``RuntimeSessions.open``
        抛错、不落行。这个 id 已有对话行（重发）时这些都不再做。

        给了 ``same_as`` 就是做同款：先把那张资料库卡挂着的对话的制作文件与素材台账拷进来，再落
        对话行。调用者没有 ``generation:read``、或 ``same_as`` 不是挂着对话的资料库卡抛
        ``NotFound``，在开会话之前；源没有工程文件或分镜文件抛 ``ValidationFailed``，那时会话已经开了。
        两种都不落行；这个 id 已有对话行时不再拷，重发不会盖掉建好之后改过的文件。"""

        now = datetime.now(UTC)
        new_id = conversation_id or uuid.uuid4()
        # 调用方铸的 id 在答复之前就可能被拿去改这段对话，created 帧与其他整行帧同样要按提交顺序广播。
        async with self._row_lock(new_id):
            if not (conversation_id is not None and await self._id_taken(conversation_id)):
                await self._require_attribution(task_id=task_id, collection_id=collection_id)
                source_owner = (
                    None if same_as is None else await self._same_as_owner(principal, same_as)
                )
                await self._runtime.open(new_id, agent_id=agent_id)
                if same_as is not None and source_owner is not None:
                    await self._copy_same_as(
                        principal, source_id=same_as, source_owner=source_owner, target_id=new_id
                    )
            conversation, created = await self._repo.create_if_absent(
                Conversation(
                    id=new_id,
                    owner_user_id=principal.user_id,
                    agent_id=agent_id,
                    title=title or DEFAULT_TITLE,
                    title_kind="custom" if title else "default",
                    last_run_id=None,
                    task_id=task_id,
                    collection_id=collection_id,
                    # 仓储使用数据库 now() 覆盖时间占位值。
                    created_at=now,
                    updated_at=now,
                )
            )
            if created:
                await self._broadcast_row("created", conversation)
        # 先广播再认领：对话行一提交就是事实，认领失败不能把 created 帧一起吞掉。重发时首次可能死在
        # 提交之后、认领之前，所以不看 created，按落库那一行补认领；认领本身幂等。
        if conversation.task_id is not None:
            await self._claim_task(conversation.task_id, conversation.owner_user_id)
        return conversation, created

    async def _id_taken(self, conversation_id: uuid.UUID) -> bool:
        """这个 id 有没有对话行，不论属主、删没删；归属与可见性仍由落库那一步判。"""

        try:
            await self._repo.get(conversation_id, owner=None, include_deleted=True)
        except NotFound:
            return False
        return True

    async def _require_attribution(
        self, *, task_id: uuid.UUID | None, collection_id: uuid.UUID | None
    ) -> None:
        """新对话要挂的需求单、合集得在；口径同外键，挂别人的合集也不拦，与 ``set_collection`` 一样。"""

        if task_id is not None and not await self._task_exists(task_id):
            raise ValidationFailed(MISSING_TASK)
        if collection_id is not None and not await self._collection_exists(collection_id):
            raise ValidationFailed(MISSING_COLLECTION)

    async def _same_as_owner(self, principal: Principal, source_id: uuid.UUID) -> uuid.UUID:
        """做同款认源，交回源对话的属主：源按资料库认，看得到资料库、源是挂着对话的卡就行，不看那段
        对话调用者读不读得到、删没删，在跑也照拷。只读不写，开会话之前做。"""

        if not principal.has("generation:read"):
            raise NotFound("资料库里没有这条视频")
        source_owner = await self._same_style_source(source_id)
        if source_owner is None:
            raise NotFound("资料库里没有这条视频")
        return source_owner

    async def _copy_same_as(
        self,
        principal: Principal,
        *,
        source_id: uuid.UUID,
        source_owner: uuid.UUID,
        target_id: uuid.UUID,
    ) -> None:
        """做同款的拷贝，源已由 ``_same_as_owner`` 认过。

        先拷文件与素材、对话行由调用方最后落，与分叉同一个顺序：中途失败只留下寻址不到的数据，
        agent 也不会在拷到一半的工作区里开跑。"""

        same_style = self._same_style_files
        if not await self._runtime.copy_files(
            source_id=source_id,
            source_user=source_owner,
            target_id=target_id,
            target_user=principal.user_id,
            files=same_style.files,
            require_any=same_style.require_any,
        ):
            raise ValidationFailed("这段对话没有工程文件或分镜文件，做不了同款")

    async def fork(
        self,
        principal: Principal,
        source_id: uuid.UUID,
        *,
        turn: int,
        title: str | None = None,
        agent_id: str | None = None,
        collection_id: uuid.UUID | None = None,
    ) -> Conversation:
        """从源对话的第 ``turn`` 轮分叉出一段属于调用者的新对话；源对话只读。

        可见范围与其他读路径一致，所以治理者连墓碑也能分叉。源没闲下来就拒绝：那时最新快照
        可能是半截的，轮号会变。

        副本不挂源的需求单：挂上就是认领，那会动到别人的单子。出片记录不拷，副本按血缘继承。

        会话、工作区、素材与种子快照由运行时的分叉写，对话行在它之后由这里写，各自独立提交。
        中途失败的副本进不了任何对话列表，也读不出 transcript。没跑完、没跑过、轮号越界与数完轮数后
        源的轮数又变了都按 ``RuntimeSessions.fork`` 抛错，不落行。给的合集不在按 ``create`` 的口径抛错，
        在调运行时之前。

        副本的会话照抄源会话的 agent 版本；换了 ``agent_id`` 就按新对话的规矩固定那个 agent 此刻的
        当前版本，不能开对话时按 ``RuntimeSessions.open`` 抛错。
        """

        source = await self._readable(principal, source_id)
        await self._require_attribution(task_id=None, collection_id=collection_id)
        target_id = uuid.uuid4()
        now = datetime.now(UTC)
        await self._runtime.fork(
            source_id=source_id,
            source_user=source.owner_user_id,
            target_id=target_id,
            target_user=principal.user_id,
            turn=turn,
            agent_id=agent_id if agent_id not in (None, source.agent_id) else None,
        )
        conversation, _ = await self._repo.create_if_absent(
            Conversation(
                id=target_id,
                owner_user_id=principal.user_id,
                agent_id=agent_id or source.agent_id,
                title=title or _fork_title(source.title, turn),
                # 自动起名不碰这个标题：它已经标明了血缘。
                title_kind="custom",
                last_run_id=None,
                task_id=None,
                collection_id=collection_id,
                created_at=now,
                updated_at=now,
                forked_from=source_id,
                fork_turn=turn,
            )
        )
        await self._broadcast_row("created", conversation)
        return conversation

    async def list_for_task(
        self, principal: Principal, task_id: uuid.UUID
    ) -> tuple[Conversation, ...]:
        """按建立时间倒序返回自己的需求单对话；需求单公开不扩大对话可见范围。"""

        return await self._repo.list_for_task(task_id=task_id, owner=principal.user_id)

    async def search(
        self, principal: Principal, *, limit: int = 20, title_query: str | None = None
    ) -> tuple[Conversation, ...]:
        """在数据库中按标题筛选，再按建立时间倒序截取，确保可搜索全部历史。"""

        check_limit(limit)
        keyword = (title_query or "").strip()
        return await self._repo.list_for_owner(
            owner=principal.user_id, limit=limit, title_contains=keyword or None
        )

    async def _state_filter(self, state: ListState, owner: uuid.UUID) -> StateFilter | None:
        """all 不筛；done / open 只看库里的收尾标记，只有 running 才需要算「此刻占着的」那个集合。"""

        if state == "all":
            return None
        busy = await self._busy_conversation_ids(owner) if state == "running" else frozenset()
        return StateFilter(state=state, busy=busy)

    async def sidebar(self, principal: Principal, *, state: ListState = "all") -> Sidebar:
        """一次读出侧栏一屏：最近建立的至多 ``SIDEBAR_COLLECTIONS`` 个合集各带总数与第一页，
        加上未分组的总数与第一页。

        三块共用同一个状态筛选，busy 集只取一次，计数与列表才对得上；所有页里的对话合起来
        只读一次活动状态。"""

        owner = principal.user_id
        chosen = await self._state_filter(state, owner)
        collections = await self._list_collections(owner, limit=SIDEBAR_COLLECTIONS)
        found = await self._repo.list_by_collections(
            owner=owner,
            collection_ids=tuple(item.id for item in collections),
            per_collection=SIDEBAR_PER_COLLECTION,
            state=chosen,
        )
        by_id = {group.collection_id: group for group in found}
        groups = tuple(
            SidebarGroup(
                collection=item,
                total=by_id[item.id].total if item.id in by_id else 0,
                page=_page(
                    by_id[item.id].conversations if item.id in by_id else (),
                    limit=SIDEBAR_PER_COLLECTION,
                ),
            )
            for item in collections
        )
        ungrouped_total = await self._repo.count_ungrouped(owner=owner, state=chosen)
        ungrouped = _page(
            await self._repo.list_ungrouped(owner=owner, limit=SIDEBAR_UNGROUPED, state=chosen),
            limit=SIDEBAR_UNGROUPED,
        )
        pages = (*(group.page for group in groups), ungrouped)
        shown = [item.id for page in pages for item in page.items]
        return Sidebar(
            groups=groups,
            ungrouped_total=ungrouped_total,
            ungrouped=ungrouped,
            activities=await self.activities(shown),
        )

    async def ungrouped(
        self, principal: Principal, *, cursor: str | None = None, state: ListState = "all"
    ) -> ConversationPage:
        """按建立时间倒序分页读取自己的未分类对话。"""

        items = await self._repo.list_ungrouped(
            owner=principal.user_id,
            limit=SIDEBAR_UNGROUPED,
            after=_after(cursor),
            state=await self._state_filter(state, principal.user_id),
        )
        return _page(items, limit=SIDEBAR_UNGROUPED)

    async def in_collection(
        self,
        principal: Principal,
        collection_id: uuid.UUID,
        *,
        cursor: str | None = None,
        state: ListState = "all",
    ) -> ConversationPage:
        """分页读取合集内的对话；不存在或不可见的合集均返回空页。"""

        items = await self._repo.list_in_collection(
            owner=principal.user_id,
            collection_id=collection_id,
            limit=SIDEBAR_PER_COLLECTION,
            after=_after(cursor),
            state=await self._state_filter(state, principal.user_id),
        )
        return _page(items, limit=SIDEBAR_PER_COLLECTION)

    async def audit(
        self,
        *,
        owner_user_id: uuid.UUID | None = None,
        task_id: uuid.UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        state: ListState = "all",
        deleted: DeletedFilter = "live",
        limit: int = 20,
        cursor: str | None = None,
    ) -> AuditPage:
        """治理者按建立时间倒序分页查询全平台对话，附当前筛选下的总数与在跑数，以及这一页各段
        自己名下最新一条素材片的地址。

        给了 ``owner_user_id`` 时占着的集合按该属主算，不给才算全平台；busy 集只取一次，
        列表与两个计数才对得上。``deleted`` 决定属主删掉的墓碑收不收，这是唯一列得出墓碑的口。
        治理者权限由路由声明，本方法不判。"""

        check_limit(limit)
        scope = AuditFilter(
            owner=owner_user_id,
            task_id=task_id,
            since=_as_utc(since),
            until=_as_utc(until),
            deleted=deleted,
        )
        busy = await self._busy_conversation_ids(owner_user_id)
        chosen = None if state == "all" else StateFilter(state=state, busy=busy)
        found = await self._repo.list_audit(scope, state=chosen, limit=limit, after=_after(cursor))
        page = _page(found, limit=limit)
        return AuditPage(
            items=page.items,
            next_cursor=page.next_cursor,
            total=await self._repo.count_audit(scope, state=chosen),
            running_total=await self._repo.count_audit(
                scope, state=StateFilter(state="running", busy=busy)
            ),
            latest_master_urls=await self._latest_master_urls([item.id for item in page.items]),
        )

    async def video_progress(self, principal: Principal) -> Mapping[uuid.UUID, VideoPhase]:
        """主体看得见的视频记录里，还没跑完的按对话汇总到哪一步。

        范围按记录的属主算：普通用户只看自己的，治理者与替人办事的钥匙看全平台。不查对话行，
        客户端只给自己列着的对话画角标。"""

        return await self._video_progress_of(visible_owner_incl_act_as(principal))

    async def rename(
        self, principal: Principal, conversation_id: uuid.UUID, *, title: str
    ) -> Conversation:
        async with self._row_lock(conversation_id):
            renamed = await self._repo.rename(conversation_id, owner=principal.user_id, title=title)
            self._announce_title(renamed.owner_user_id, conversation_id, renamed.title)
            await self._broadcast_row("updated", renamed)
        return renamed

    async def name_at_turn_start(self, conversation_id: uuid.UUID, user_text: str) -> None:
        """一轮开始时按这一轮的用户消息生成 default 标题，与这一轮的运行并行。

        本次未生成时保留 default，下一轮开始时再试。生成标题要调模型，放在行锁外面，
        免得这段对话的改名、开跑等写入跟着等。"""

        conversation = await self._repo.get(conversation_id, owner=None)
        if conversation.title_kind != "default":
            return
        title = await self._generate_title(user_text)
        if title is None:
            return
        async with self._row_lock(conversation_id):
            # SQL 条件更新防止生成期间的用户改名被覆盖。
            if await self._repo.apply_generated_title(conversation_id, title=title):
                self._announce_title(conversation.owner_user_id, conversation_id, title)

    async def set_collection(
        self, principal: Principal, conversation_id: uuid.UUID, *, collection_id: uuid.UUID | None
    ) -> Conversation:
        """设置或清空对话的合集归属。"""

        async with self._row_lock(conversation_id):
            conversation = await self._repo.set_collection(
                conversation_id, owner=principal.user_id, collection_id=collection_id
            )
            await self._broadcast_row("updated", conversation)
        return conversation

    async def set_task(
        self, principal: Principal, conversation_id: uuid.UUID, *, task_id: uuid.UUID | None
    ) -> Conversation:
        """设置或清空需求单归属。尝试顺序按对话创建时间计算，重新关联不会改变创建时间。
        挂上的那张单由属主认领；摘掉不动认领记录。"""

        async with self._row_lock(conversation_id):
            conversation = await self._repo.set_task(
                conversation_id, owner=principal.user_id, task_id=task_id
            )
            await self._broadcast_row("updated", conversation)
        # 认领是别的模块的端口，不放在行锁里；行一提交就是事实，先广播，认领失败也不吞掉这一帧。
        # 重新挂同一张单照样认领一次（认领幂等），失败后重试即可补上。
        if conversation.task_id is not None:
            await self._claim_task(conversation.task_id, conversation.owner_user_id)
        return conversation

    async def set_completed(
        self, principal: Principal, conversation_id: uuid.UUID, *, completed: bool
    ) -> Conversation:
        """标记或取消属主的收尾标记。机器不会自己标；属主再动手会自动取消。"""

        async with self._row_lock(conversation_id):
            conversation = await self._repo.set_completed(
                conversation_id, owner=principal.user_id, completed=completed
            )
            await self._broadcast_row("updated", conversation)
        return conversation

    async def clear_completed(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        """属主在这段对话里又干活了（如提交出片），收尾标记不再成立。

        供别的域在受理成功后回调：对话不存在、已删或不是这个人的都当没发生，不影响调用方。
        标记本来就是空时照样写一次：提交出片本身就是活动，`updated_at` 该跟着走；行变了就广播
        ``updated``，与属主手动取消同一种帧。"""

        async with self._row_lock(conversation_id):
            try:
                conversation = await self._repo.set_completed(
                    conversation_id, owner=owner, completed=False
                )
            except NotFound:
                _logger.debug("对话不可见，跳过取消收尾标记", conversation_id=str(conversation_id))
                return
            await self._broadcast_row("updated", conversation)

    async def delete(self, principal: Principal, conversation_id: uuid.UUID) -> None:
        """把对话标记删除。工作区与素材台账留着，治理者复盘时还要看。"""

        await self._repo.delete(conversation_id, owner=principal.user_id)
        self._announce_deleted(principal.user_id, conversation_id)

    async def begin_run(
        self,
        *,
        owner: uuid.UUID,
        agent_id: str,
        conversation_id: str,
        run_id: str,
        activity: ConversationActivity | None = None,
    ) -> None:
        """解析对话 id、核对属主与 Agent 后记录运行，再广播 ``updated``（照 Kimi 会话元数据一变就发）。

        这一帧带出新的 ``lastRunId`` 与被抹掉的收尾标记。给了 ``activity`` 就用它作行里的活动，不再经
        ``ActivitiesOf`` 去读。"""

        parsed = _as_conversation_id(conversation_id)
        async with self._row_lock(parsed):
            conversation = await self._repo.touch_run(
                parsed, owner=owner, agent_id=agent_id, run_id=run_id
            )
            await self._broadcast_row("updated", conversation, activity=activity)

    async def begin_reported_run(
        self, conversation_id: uuid.UUID, *, run_id: str, activity: ConversationActivity
    ) -> None:
        """运行时回调报来的开跑：照 ``begin_run`` 记录运行并广播，行里的活动用回调带来的那份。

        回调只带对话 id，属主与 Agent 取这一行自己的；对话不存在或已删抛 ``NotFound``。"""

        conversation = await self._repo.get(conversation_id, owner=None)
        await self.begin_run(
            owner=conversation.owner_user_id,
            agent_id=conversation.agent_id,
            conversation_id=str(conversation_id),
            run_id=run_id,
            activity=activity,
        )

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        """从可见对话中读取 Agent，拒绝由调用方指定 Agent 绕过对话绑定。

        读取允许治理者跨属主访问，含已删的墓碑；写入始终限定属主活着的对话。也认 agent 测试预览，
        口径见 ``_session``。"""

        parsed = _as_conversation_id(conversation_id)
        return (await self._session(principal, parsed, writing=writing)).agent_id

    async def get(self, principal: Principal, conversation_id: uuid.UUID) -> Conversation:
        """按 id 读一段对话的整行，可见范围同其他读路径：治理者含墓碑，其余人只见自己活着的。"""

        return await self._readable(principal, conversation_id)

    async def header_of(
        self, principal: Principal, conversation_id: str
    ) -> Conversation | PreviewHeader:
        """读取可见对话的整行，可见范围同 ``agent_of(writing=False)``。会话页首屏用它贴标题、属主与
        删除时刻并取 Agent，一行只读一次；后续改名经 session.meta.updated 推送。预览给固定标题，不查不起。"""

        session = await self._session(
            principal, _as_conversation_id(conversation_id), writing=False
        )
        if isinstance(session, AgentPreview):
            return PreviewHeader(agent_id=session.agent_id, owner_user_id=session.owner_user_id)
        return session

    # --- agent 测试预览 -----------------------------------------------------------

    async def open_preview(
        self, principal: Principal, agent_id: str, *, version_id: uuid.UUID | None
    ) -> AgentPreview:
        """给调用者开一段 agent 测试预览：``version_id`` 为空试这个 agent 当下的草稿，否则试它的那一版。

        运行时那边先开预览会话，再落行；没有这个 agent 是 ``NotFound``，版本不是它的是 ``ValidationFailed``。
        中途失败只留下寻址不到的运行时会话。端点已核 ``agent:manage``。"""

        preview_id = uuid.uuid4()
        await self._runtime.open_preview(preview_id, agent_id=agent_id, version_id=version_id)
        return await self._previews.create(
            preview_id, owner=principal.user_id, agent_id=agent_id, version_id=version_id
        )

    async def is_preview(self, session_id: str) -> bool:
        """这个 id 是不是一段 agent 测试预览（只按主键查，不判谁能用）；不是 UUID 的算不是。给要把预览
        与对话分开记账的内部入口用。"""

        try:
            parsed = uuid.UUID(session_id)
        except ValueError:
            return False
        return await self._previews.get(parsed) is not None

    async def delete_preview(
        self, principal: Principal, agent_id: str, preview_id: uuid.UUID
    ) -> None:
        """删掉调用者自己的一段预览；只删这一行，运行时的会话与它的记录留着、再也寻址不到。不是他的、
        不是这个 agent 的、没有这一段都是 ``NotFound``。"""

        if not await self._previews.delete(preview_id, owner=principal.user_id, agent_id=agent_id):
            raise NotFound("没有这段预览")


__all__ = [
    "IDLE_ACTIVITY",
    "SIDEBAR_COLLECTIONS",
    "SIDEBAR_PER_COLLECTION",
    "SIDEBAR_UNGROUPED",
    "ActivitiesOf",
    "AgentDirectory",
    "AgentEntry",
    "AnnounceConversationDeleted",
    "AnnounceConversationRow",
    "AuditPage",
    "BusyConversationIds",
    "ClaimTask",
    "CollectionExists",
    "CollectionInfo",
    "ConversationFilm",
    "ConversationService",
    "DeletedFilter",
    "DerivedFile",
    "DerivedFileContent",
    "LatestMasterUrls",
    "ListAgents",
    "ListCollections",
    "ListDerivedFiles",
    "ListState",
    "ReadDerivedFile",
    "RuntimeSessions",
    "SameStyleFiles",
    "Sidebar",
    "SidebarGroup",
    "TaskExists",
    "VideoProgressOf",
    "WholeFilmDraftReferences",
    "WholeFilmExports",
    "WholeFilmRenderUnavailable",
    "WorkspaceDocumentValidator",
    "WriteDerivedFile",
]
