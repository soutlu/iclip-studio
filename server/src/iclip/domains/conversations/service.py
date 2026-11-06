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
SIDEBAR_UNGROUPED = 20
SIDEBAR_PER_COLLECTION = 10

ListState = Literal["all", "running", "done", "open"]


@dataclass(frozen=True, slots=True)
class AgentEntry:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class AgentDirectory:
    items: tuple[AgentEntry, ...]
    default: str | None


ListAgents = Callable[[], Awaitable[AgentDirectory]]


class RuntimeSessions(Protocol):
    async def open(self, session_id: uuid.UUID, *, agent_id: str) -> None: ...

    async def abort(self, session_id: uuid.UUID) -> None: ...

    async def open_preview(
        self, session_id: uuid.UUID, *, agent_id: str, version_id: uuid.UUID | None
    ) -> None: ...

    async def fork(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None: ...

    async def copy_files(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool: ...


ActivitiesOf = Callable[[Sequence[uuid.UUID]], Awaitable[Mapping[uuid.UUID, ConversationActivity]]]

BusyConversationIds = Callable[[uuid.UUID | None], Awaitable[frozenset[uuid.UUID]]]

LatestMasterUrls = Callable[[Sequence[uuid.UUID]], Awaitable[Mapping[uuid.UUID, str]]]

VideoProgressOf = Callable[[uuid.UUID | None], Awaitable[Mapping[uuid.UUID, VideoPhase]]]

GenerateTitle = Callable[[str], Awaitable[str | None]]

AnnounceTitle = Callable[[uuid.UUID, uuid.UUID, str], None]

AnnounceConversationRow = Callable[
    [Literal["created", "updated"], uuid.UUID, uuid.UUID, Mapping[str, Any]], None
]

AnnounceConversationDeleted = Callable[[uuid.UUID, uuid.UUID], None]


@dataclass(frozen=True, slots=True)
class DerivedFile:
    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class DerivedFileContent:
    path: str
    content: str
    version: int


@dataclass(frozen=True, slots=True)
class CollectionInfo:
    id: uuid.UUID
    name: str
    updated_at: datetime


class ListCollections(Protocol):
    async def __call__(self, owner: uuid.UUID, *, limit: int) -> Sequence[CollectionInfo]: ...


ClaimTask = Callable[[uuid.UUID, uuid.UUID], Awaitable[None]]

TaskExists = Callable[[uuid.UUID], Awaitable[bool]]

CollectionExists = Callable[[uuid.UUID], Awaitable[bool]]


@dataclass(frozen=True, slots=True)
class SameStyleFiles:
    files: tuple[tuple[str, str], ...]
    require_any: frozenset[str]


class SameStyleSource(Protocol):
    async def __call__(self, card_id: uuid.UUID) -> uuid.UUID | None: ...


ListDerivedFiles = Callable[[uuid.UUID, uuid.UUID], Awaitable[Sequence[DerivedFile]]]

ReadDerivedFile = Callable[[uuid.UUID, uuid.UUID, str], Awaitable[DerivedFileContent | None]]

WriteDerivedFile = Callable[[uuid.UUID, uuid.UUID, str, str, int], Awaitable[DerivedFileContent]]


class ConversationFilm(Protocol):
    async def view(
        self, principal: Principal, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> FilmView | None: ...

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
    ) -> FilmView: ...

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
    ) -> uuid.UUID: ...

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
    ) -> uuid.UUID: ...


class WholeFilmDraftReferences(Protocol):
    async def __call__(
        self, principal: Principal, conversation_id: uuid.UUID, document: WholeFilmDocument
    ) -> None: ...


class WholeFilmRenderUnavailable(Exception):
    pass


class WholeFilmExports(Protocol):
    async def start(
        self,
        principal: Principal,
        *,
        conversation_id: uuid.UUID,
        revision: int,
        document: WholeFilmDocument,
    ) -> uuid.UUID: ...

    async def latest(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID
    ) -> WholeFilmExport | None: ...

    async def cancel(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID, export_id: uuid.UUID
    ) -> None: ...


_EXPORTS_OFF = "成片导出没有开通"


class WorkspaceDocumentValidator(Protocol):
    async def __call__(
        self, owner: uuid.UUID, conversation_id: uuid.UUID, content: str
    ) -> None: ...


def _as_utc(moment: datetime | None) -> datetime | None:
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _fork_title(source_title: str, turn: int) -> str:
    suffix = f"（分叉 · 第 {turn} 轮）"
    return source_title[: MAX_TITLE_CHARS - len(suffix)] + suffix


def _as_conversation_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise NotFound("没有这段对话") from exc


@dataclass(frozen=True, slots=True)
class ConversationPage:
    items: tuple[Conversation, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class AuditPage:
    items: tuple[Conversation, ...]
    next_cursor: str | None
    total: int
    running_total: int
    latest_master_urls: Mapping[uuid.UUID, str]


@dataclass(frozen=True, slots=True)
class SidebarGroup:
    collection: CollectionInfo
    total: int
    page: ConversationPage


@dataclass(frozen=True, slots=True)
class Sidebar:
    groups: tuple[SidebarGroup, ...]
    ungrouped_total: int
    ungrouped: ConversationPage
    activities: Mapping[uuid.UUID, ConversationActivity]


def _page(items: tuple[Conversation, ...], *, limit: int) -> ConversationPage:
    last = items[-1] if len(items) == limit else None
    return ConversationPage(
        items=items,
        next_cursor=None if last is None else encode_cursor(last.created_at, last.id),
    )


def _after(cursor: str | None) -> PageCursor | None:
    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return PageCursor(created_at=parsed.at, conversation_id=parsed.uuid_key())


class ConversationService:
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
        if activity is None:
            activity = (await self.activities([conversation.id]))[conversation.id]
        row = conversation_out(conversation, activity).model_dump(mode="json", by_alias=True)
        self._announce_row(kind, conversation.owner_user_id, conversation.id, row)

    async def activities(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        known = await self._activities_of(conversation_ids)
        return {one: known.get(one, IDLE_ACTIVITY) for one in conversation_ids}

    async def _readable(self, principal: Principal, conversation_id: uuid.UUID) -> Conversation:
        if principal.has(MANAGE_PERMISSION):
            return await self._repo.get(conversation_id, owner=None, include_deleted=True)
        return await self._repo.get(conversation_id, owner=visible_owner_incl_act_as(principal))

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        try:
            await self._readable(principal, conversation_id)
        except NotFound:
            return False
        return True

    async def _session(
        self, principal: Principal, conversation_id: uuid.UUID, *, writing: bool
    ) -> Conversation | AgentPreview:
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
        session = await self._session(principal, conversation_id, writing=False)
        return await self._list_derived_files(session.owner_user_id, session.id)

    async def file(
        self, principal: Principal, conversation_id: uuid.UUID, *, path: str
    ) -> DerivedFileContent:
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
        conversation = await self._workspace_writable(principal, conversation_id)
        validate = self._document_validators.get(path)
        if validate is not None:
            await validate(conversation.owner_user_id, conversation.id, content)
        return await self._write_derived_file(
            conversation.owner_user_id, conversation.id, path, content, expected_version
        )

    async def film(self, principal: Principal, conversation_id: uuid.UUID) -> FilmView:
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
        conversation = await self._workspace_writable(principal, conversation_id)
        return await self._require_exports().latest(
            conversation_id=conversation.id, owner_user_id=conversation.owner_user_id
        )

    async def cancel_whole_film_export(
        self, principal: Principal, conversation_id: uuid.UUID, export_id: uuid.UUID
    ) -> None:
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
        return await self._workspace_writable(principal, conversation_id)

    async def _workspace_writable(
        self, principal: Principal, conversation_id: uuid.UUID
    ) -> Conversation:
        conversation = await self._readable(principal, conversation_id)
        if conversation.owner_user_id != principal.user_id:
            raise PermissionDenied("只有属主能改这段对话")
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
        now = datetime.now(UTC)
        new_id = conversation_id or uuid.uuid4()
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
                    created_at=now,
                    updated_at=now,
                )
            )
            if created:
                await self._broadcast_row("created", conversation)
        if conversation.task_id is not None:
            await self._claim_task(conversation.task_id, conversation.owner_user_id)
        return conversation, created

    async def _id_taken(self, conversation_id: uuid.UUID) -> bool:
        try:
            await self._repo.get(conversation_id, owner=None, include_deleted=True)
        except NotFound:
            return False
        return True

    async def _require_attribution(
        self, *, task_id: uuid.UUID | None, collection_id: uuid.UUID | None
    ) -> None:
        if task_id is not None and not await self._task_exists(task_id):
            raise ValidationFailed(MISSING_TASK)
        if collection_id is not None and not await self._collection_exists(collection_id):
            raise ValidationFailed(MISSING_COLLECTION)

    async def _same_as_owner(self, principal: Principal, source_id: uuid.UUID) -> uuid.UUID:
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
        return await self._repo.list_for_task(task_id=task_id, owner=principal.user_id)

    async def search(
        self, principal: Principal, *, limit: int = 20, title_query: str | None = None
    ) -> tuple[Conversation, ...]:
        check_limit(limit)
        keyword = (title_query or "").strip()
        return await self._repo.list_for_owner(
            owner=principal.user_id, limit=limit, title_contains=keyword or None
        )

    async def _state_filter(self, state: ListState, owner: uuid.UUID) -> StateFilter | None:
        if state == "all":
            return None
        busy = await self._busy_conversation_ids(owner) if state == "running" else frozenset()
        return StateFilter(state=state, busy=busy)

    async def sidebar(self, principal: Principal, *, state: ListState = "all") -> Sidebar:
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
        conversation = await self._repo.get(conversation_id, owner=None)
        if conversation.title_kind != "default":
            return
        title = await self._generate_title(user_text)
        if title is None:
            return
        async with self._row_lock(conversation_id):
            if await self._repo.apply_generated_title(conversation_id, title=title):
                self._announce_title(conversation.owner_user_id, conversation_id, title)

    async def set_collection(
        self, principal: Principal, conversation_id: uuid.UUID, *, collection_id: uuid.UUID | None
    ) -> Conversation:
        async with self._row_lock(conversation_id):
            conversation = await self._repo.set_collection(
                conversation_id, owner=principal.user_id, collection_id=collection_id
            )
            await self._broadcast_row("updated", conversation)
        return conversation

    async def set_task(
        self, principal: Principal, conversation_id: uuid.UUID, *, task_id: uuid.UUID | None
    ) -> Conversation:
        async with self._row_lock(conversation_id):
            conversation = await self._repo.set_task(
                conversation_id, owner=principal.user_id, task_id=task_id
            )
            await self._broadcast_row("updated", conversation)
        if conversation.task_id is not None:
            await self._claim_task(conversation.task_id, conversation.owner_user_id)
        return conversation

    async def set_completed(
        self, principal: Principal, conversation_id: uuid.UUID, *, completed: bool
    ) -> Conversation:
        async with self._row_lock(conversation_id):
            conversation = await self._repo.set_completed(
                conversation_id, owner=principal.user_id, completed=completed
            )
            await self._broadcast_row("updated", conversation)
        return conversation

    async def clear_completed(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
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
        parsed = _as_conversation_id(conversation_id)
        async with self._row_lock(parsed):
            conversation = await self._repo.touch_run(
                parsed, owner=owner, agent_id=agent_id, run_id=run_id
            )
            await self._broadcast_row("updated", conversation, activity=activity)

    async def begin_reported_run(
        self, conversation_id: uuid.UUID, *, run_id: str, activity: ConversationActivity
    ) -> None:
        conversation = await self._repo.get(conversation_id, owner=None)
        await self.begin_run(
            owner=conversation.owner_user_id,
            agent_id=conversation.agent_id,
            conversation_id=str(conversation_id),
            run_id=run_id,
            activity=activity,
        )

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        parsed = _as_conversation_id(conversation_id)
        return (await self._session(principal, parsed, writing=writing)).agent_id

    async def get(self, principal: Principal, conversation_id: uuid.UUID) -> Conversation:
        return await self._readable(principal, conversation_id)

    async def header_of(
        self, principal: Principal, conversation_id: str
    ) -> Conversation | PreviewHeader:
        session = await self._session(
            principal, _as_conversation_id(conversation_id), writing=False
        )
        if isinstance(session, AgentPreview):
            return PreviewHeader(agent_id=session.agent_id, owner_user_id=session.owner_user_id)
        return session

    async def open_preview(
        self, principal: Principal, agent_id: str, *, version_id: uuid.UUID | None
    ) -> AgentPreview:
        preview_id = uuid.uuid4()
        await self._runtime.open_preview(preview_id, agent_id=agent_id, version_id=version_id)
        current = await self._previews.current(owner=principal.user_id, agent_id=agent_id)
        if current is not None:
            await self._runtime.abort(current.id)
        return await self._previews.replace(
            preview_id, owner=principal.user_id, agent_id=agent_id, version_id=version_id
        )


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
