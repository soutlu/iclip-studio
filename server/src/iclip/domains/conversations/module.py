"""conversations 装配单元：组合根只调用 ``build_conversations_module``。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from iclip.domains.conversations.api import create_conversations_router, create_previews_router
from iclip.domains.conversations.repository import (
    AgentPreviewStore,
    ConversationRepository,
    WholeFilmDraftStore,
)
from iclip.domains.conversations.service import (
    ActivitiesOf,
    AnnounceConversationDeleted,
    AnnounceConversationRow,
    AnnounceTitle,
    BusyConversationIds,
    ClaimTask,
    CollectionExists,
    ConversationFilm,
    ConversationService,
    GenerateTitle,
    LatestMasterUrls,
    ListAgents,
    ListCollections,
    ListDerivedFiles,
    ReadDerivedFile,
    RuntimeSessions,
    SameStyleFiles,
    SameStyleSource,
    TaskExists,
    VideoProgressOf,
    WholeFilmDraftReferences,
    WholeFilmExports,
    WorkspaceDocumentValidator,
    WriteDerivedFile,
)
from iclip.domains.identity.public import ActAs


@dataclass(frozen=True)
class ConversationsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: ConversationService


def build_conversations_module(
    repo: ConversationRepository,
    *,
    previews: AgentPreviewStore,
    act_as: ActAs,
    list_agents: ListAgents,
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
) -> ConversationsModule:
    """外部依赖由组合根注入，协议定义见 service.py。"""

    service = ConversationService(
        repo,
        previews=previews,
        runtime=runtime,
        list_collections=list_collections,
        claim_task=claim_task,
        task_exists=task_exists,
        collection_exists=collection_exists,
        list_derived_files=list_derived_files,
        read_derived_file=read_derived_file,
        write_derived_file=write_derived_file,
        document_validators=document_validators,
        film=film,
        drafts=drafts,
        draft_references=draft_references,
        exports=exports,
        generate_title=generate_title,
        announce_title=announce_title,
        activities_of=activities_of,
        busy_conversation_ids=busy_conversation_ids,
        latest_master_urls=latest_master_urls,
        video_progress_of=video_progress_of,
        same_style_files=same_style_files,
        same_style_source=same_style_source,
        announce_row=announce_row,
        announce_deleted=announce_deleted,
    )
    return ConversationsModule(
        routers=(
            create_conversations_router(service, agents=list_agents, act_as=act_as),
            create_previews_router(service),
        ),
        service=service,
    )


__all__ = ["ConversationsModule", "build_conversations_module"]
