"""建对话、做同款、分叉在运行时写任何东西之前挡掉的那几种：需求单或合集不在、做同款认不到源。不连库。

运行时的会话、文件与台账各开各的事务，用例最后才落对话行；在这之前就能判的失败要先判，否则留下
一份没有对话行、谁也寻址不到的会话。外键仍兜底，见集成测试 ``test_missing_attribution_is_still_reported_as_such``。
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import NoReturn, cast

import pytest
from agent_runtime.errors import NotFound, ValidationFailed

from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.repository import (
    MISSING_COLLECTION,
    MISSING_TASK,
    ConversationRepository,
    WholeFilmDraftStore,
)
from iclip.domains.conversations.service import ConversationService, SameStyleFiles
from iclip.domains.identity.public import Principal
from tests.helpers.film import UnusedFilmPage

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
OWNER = Principal(
    kind="user", user_id=uuid.uuid4(), permissions=frozenset({"agent:run"}), audit_label="logan"
)
SOURCE = Conversation(
    id=uuid.uuid4(),
    owner_user_id=OWNER.user_id,
    agent_id="storyboard",
    title="源对话",
    title_kind="custom",
    last_run_id=None,
    task_id=None,
    collection_id=None,
    created_at=NOW,
    updated_at=NOW,
)


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("这里用不到这个端口")


class SourceOnlyRepo:
    """只读得到源对话；落行一碰就报错。"""

    async def get(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None, include_deleted: bool = False
    ) -> Conversation:
        if conversation_id != SOURCE.id:
            raise NotFound("没有这段对话")
        return SOURCE

    async def create_if_absent(self, conversation: Conversation) -> tuple[Conversation, bool]:
        raise AssertionError("前置校验没过，不该落对话行")


class UntouchedRuntime:
    """运行时会话的替身：开会话、分叉、拷文件一碰就报错，用来断言运行时什么都没写。"""

    async def open(self, session_id: uuid.UUID, *, agent_id: str) -> None:
        raise AssertionError("前置校验没过，不该在运行时开会话")

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
        raise AssertionError("前置校验没过，不该在运行时分叉")

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
        raise AssertionError("前置校验没过，不该拷文件")


async def _missing(_: uuid.UUID) -> bool:
    return False


async def _exists(_: uuid.UUID) -> bool:
    return True


async def _no_card(card_id: uuid.UUID) -> uuid.UUID | None:
    return None


def build(*, task_present: bool = True, collection_present: bool = True) -> ConversationService:
    return ConversationService(
        cast("ConversationRepository", SourceOnlyRepo()),
        runtime=UntouchedRuntime(),
        list_collections=_untouched,
        claim_task=_untouched,
        task_exists=_exists if task_present else _missing,
        collection_exists=_exists if collection_present else _missing,
        list_derived_files=_untouched,
        read_derived_file=_untouched,
        write_derived_file=_untouched,
        document_validators={},
        film=UnusedFilmPage(),
        drafts=cast("WholeFilmDraftStore", object()),
        draft_references=_untouched,
        exports=None,
        generate_title=_untouched,
        announce_title=_untouched,
        activities_of=_untouched,
        busy_conversation_ids=_untouched,
        latest_master_urls=_untouched,
        video_progress_of=_untouched,
        same_style_files=SameStyleFiles(files=(), require_any=frozenset()),
        same_style_source=_no_card,
        announce_row=_untouched,
        announce_deleted=_untouched,
    )


async def test_a_missing_task_fails_the_create_before_the_runtime_opens_a_session() -> None:
    with pytest.raises(ValidationFailed) as raised:
        await build(task_present=False).create(
            OWNER, agent_id="storyboard", conversation_id=uuid.uuid4(), task_id=uuid.uuid4()
        )

    assert str(raised.value) == MISSING_TASK


async def test_a_missing_collection_fails_the_create_before_the_runtime_opens_a_session() -> None:
    with pytest.raises(ValidationFailed) as raised:
        await build(collection_present=False).create(
            OWNER, agent_id="storyboard", collection_id=uuid.uuid4()
        )

    assert str(raised.value) == MISSING_COLLECTION


async def test_a_same_as_without_a_library_card_fails_before_the_runtime_opens_a_session() -> None:
    reader = Principal(
        kind="user",
        user_id=OWNER.user_id,
        permissions=frozenset({"agent:run", "generation:read"}),
        audit_label="logan",
    )

    with pytest.raises(NotFound, match="资料库里没有这条视频"):
        await build().create(reader, agent_id="storyboard", same_as=uuid.uuid4())


async def test_a_missing_collection_fails_the_fork_before_the_runtime_forks() -> None:
    with pytest.raises(ValidationFailed) as raised:
        await build(collection_present=False).fork(
            OWNER, SOURCE.id, turn=1, collection_id=uuid.uuid4()
        )

    assert str(raised.value) == MISSING_COLLECTION
