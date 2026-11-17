from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, NoReturn, cast

import httpx
import pytest
from pydantic import ValidationError

from iclip.common.errors import NotFound, PermissionDenied
from iclip.common.final_cut import TargetLocale
from iclip.domains.conversations.api import create_final_cut_project_router
from iclip.domains.conversations.final_cut_project import FinalCutProject, PreviewTokens
from iclip.domains.conversations.final_cut_translation import (
    MAX_TRANSLATION_ENTRIES,
    MAX_TRANSLATION_ID_CHARS,
    MAX_TRANSLATION_TEXT_CHARS,
    MAX_TRANSLATION_TOTAL_CHARS,
    FinalCutText,
    FinalCutTranslator,
)
from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.repository import AgentPreviewStore, ConversationRepository
from iclip.domains.conversations.service import (
    ConversationService,
    RuntimeSessions,
    SameStyleFiles,
)
from iclip.domains.conversations.whole_film_schemas import FinalCutTranslationsIn
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal
from tests.helpers.app import app_with_principal
from tests.helpers.film import UnusedFilmPage
from tests.helpers.references import FakeArk, ark_translator, model_unavailable, responses_body

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
OWNER = Principal(
    kind="user", user_id=uuid.uuid4(), permissions=frozenset({"agent:run"}), audit_label="logan"
)
STRANGER = Principal(
    kind="user", user_id=uuid.uuid4(), permissions=frozenset({"agent:run"}), audit_label="mallory"
)
GOVERNOR = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"agent:run", MANAGE_PERMISSION}),
    audit_label="gov",
)
LIVE = Conversation(
    id=uuid.uuid4(),
    owner_user_id=OWNER.user_id,
    agent_id="storyboard",
    title="片子",
    title_kind="custom",
    last_run_id=None,
    task_id=None,
    collection_id=None,
    created_at=NOW,
    updated_at=NOW,
)
DELETED = replace(LIVE, id=uuid.uuid4(), deleted_at=NOW)
ENTRIES = (FinalCutText(id="b", text="第二句"), FinalCutText(id="a", text="第一句\n换行"))


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("这里用不到这个端口")


class TwoConversations:
    """一段活着的对话和一段属主删掉的对话，可见范围照仓储的约定：``owner`` 不对或删了都看不见。"""

    async def get(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None, include_deleted: bool = False
    ) -> Conversation:
        for one in (LIVE, DELETED):
            if one.id != conversation_id:
                continue
            if owner is not None and owner != one.owner_user_id:
                break
            if one.deleted_at is not None and not include_deleted:
                break
            return one
        raise NotFound("没有这段对话")


class RecordingTranslator:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[FinalCutText, ...], TargetLocale]] = []

    async def translate(
        self, entries: Sequence[FinalCutText], *, locale: TargetLocale, model_group: str | None
    ) -> tuple[FinalCutText, ...]:
        self.calls.append((tuple(entries), locale))
        return tuple(FinalCutText(id=one.id, text=f"{locale}:{one.text}") for one in entries)


async def _default_group(_user_id: uuid.UUID) -> str | None:
    return None


def project(translator: FinalCutTranslator) -> FinalCutProject:
    service = ConversationService(
        cast("ConversationRepository", TwoConversations()),
        previews=cast("AgentPreviewStore", object()),
        runtime=cast("RuntimeSessions", object()),
        list_collections=_untouched,
        claim_task=_untouched,
        task_exists=_untouched,
        collection_exists=_untouched,
        list_derived_files=_untouched,
        read_derived_file=_untouched,
        write_derived_file=_untouched,
        document_validators={},
        film=UnusedFilmPage(),
        exports=None,
        generate_title=_untouched,
        model_group_of=_untouched,
        announce_title=_untouched,
        activities_of=_untouched,
        busy_conversation_ids=_untouched,
        latest_master_urls=_untouched,
        video_progress_of=_untouched,
        same_style_files=SameStyleFiles(files=(), require_any=frozenset()),
        same_style_source=_untouched,
        announce_row=_untouched,
        announce_deleted=_untouched,
    )
    return FinalCutProject(
        service,
        read_file=_untouched,
        write_file=_untouched,
        preview_origin=None,
        tokens=PreviewTokens("unit-test-secret"),
        translator=translator,
        model_group_of=_default_group,
    )


async def test_the_owner_gets_one_translation_per_entry_in_request_order() -> None:
    translator = RecordingTranslator()

    translated = await project(translator).translate(OWNER, LIVE.id, locale="de", entries=ENTRIES)

    assert translated == (
        FinalCutText(id="b", text="de:第二句"),
        FinalCutText(id="a", text="de:第一句\n换行"),
    )
    assert translator.calls == [(ENTRIES, "de")]


@pytest.mark.parametrize(
    ("principal", "conversation_id", "error"),
    [
        pytest.param(STRANGER, LIVE.id, NotFound, id="stranger-cannot-see"),
        pytest.param(OWNER, DELETED.id, NotFound, id="owner-deleted-it"),
        pytest.param(OWNER, uuid.uuid4(), NotFound, id="no-such-conversation"),
        pytest.param(GOVERNOR, LIVE.id, PermissionDenied, id="governor-is-not-owner"),
        pytest.param(GOVERNOR, DELETED.id, PermissionDenied, id="governor-sees-deleted"),
    ],
)
async def test_only_the_owner_of_a_live_conversation_reaches_the_model(
    principal: Principal, conversation_id: uuid.UUID, error: type[Exception]
) -> None:
    translator = RecordingTranslator()

    with pytest.raises(error):
        await project(translator).translate(
            principal, conversation_id, locale="en", entries=ENTRIES
        )
    assert translator.calls == []


def body(**overrides: Any) -> dict[str, Any]:
    return {"targetLocale": "fr", "entries": [{"id": "a", "text": "你好"}]} | overrides


@pytest.mark.parametrize("locale", ["zh", "en", "de", "es", "fr"])
def test_each_supported_locale_is_accepted(locale: str) -> None:
    parsed = FinalCutTranslationsIn.model_validate(body(targetLocale=locale))

    assert parsed.target_locale == locale
    assert parsed.texts() == (FinalCutText(id="a", text="你好"),)


def test_entry_count_and_id_length_limits_are_inclusive() -> None:
    entries = [
        {"id": f"{index:0{MAX_TRANSLATION_ID_CHARS}d}", "text": "字"}
        for index in range(MAX_TRANSLATION_ENTRIES)
    ]

    parsed = FinalCutTranslationsIn.model_validate(body(entries=entries))

    assert len(parsed.entries) == MAX_TRANSLATION_ENTRIES


def full_batch(extra_chars: int) -> list[dict[str, str]]:
    """每条都是最长的 500 字，凑满总字数上限，再在最后一条之外多 ``extra_chars`` 字。"""

    count, rest = divmod(MAX_TRANSLATION_TOTAL_CHARS, MAX_TRANSLATION_TEXT_CHARS)
    entries = [{"id": f"e{n}", "text": "字" * MAX_TRANSLATION_TEXT_CHARS} for n in range(count)]
    if rest + extra_chars:
        entries.append({"id": "last", "text": "字" * (rest + extra_chars)})
    return entries


def test_a_batch_of_exactly_the_total_limit_is_accepted() -> None:
    parsed = FinalCutTranslationsIn.model_validate(body(entries=full_batch(0)))

    assert sum(len(one.text) for one in parsed.entries) == MAX_TRANSLATION_TOTAL_CHARS


def test_one_character_over_the_total_limit_refuses_the_whole_batch() -> None:
    with pytest.raises(ValidationError) as caught:
        FinalCutTranslationsIn.model_validate(body(entries=full_batch(1)))

    assert f"一批最多 {MAX_TRANSLATION_TOTAL_CHARS} 字" in str(caught.value)
    assert f"这一批有 {MAX_TRANSLATION_TOTAL_CHARS + 1} 字" in str(caught.value)


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"targetLocale": "ja"}, id="unsupported-locale"),
        pytest.param({"targetLocale": None}, id="no-locale"),
        pytest.param({"entries": []}, id="no-entries"),
        pytest.param(
            {"entries": [{"id": str(n), "text": "字"} for n in range(MAX_TRANSLATION_ENTRIES + 1)]},
            id="too-many-entries",
        ),
        pytest.param({"entries": [{"id": "a", "text": ""}]}, id="empty-text"),
        pytest.param({"entries": [{"id": "a", "text": " \n\t"}]}, id="blank-text"),
        pytest.param(
            {"entries": [{"id": "a", "text": "字" * (MAX_TRANSLATION_TEXT_CHARS + 1)}]},
            id="text-too-long",
        ),
        pytest.param({"entries": [{"id": "", "text": "字"}]}, id="empty-id"),
        pytest.param(
            {"entries": [{"id": "i" * (MAX_TRANSLATION_ID_CHARS + 1), "text": "字"}]},
            id="id-too-long",
        ),
        pytest.param(
            {"entries": [{"id": "a", "text": "一"}, {"id": "a", "text": "二"}]}, id="duplicate-id"
        ),
        pytest.param({"sourceLocale": "zh"}, id="source-locale-is-not-accepted"),
    ],
)
def test_irregular_requests_are_refused(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        FinalCutTranslationsIn.model_validate(body(**overrides))


def model_says(*pairs: tuple[str, str]) -> httpx.Response:
    raw = json.dumps({"translations": [{"id": key, "text": text} for key, text in pairs]})
    return httpx.Response(200, json=responses_body(raw))


@asynccontextmanager
async def route_for(principal: Principal, ark: FakeArk) -> AsyncGenerator[httpx.AsyncClient]:
    """只装 final-cut 的路由与统一错误处理，模型走真的方舟适配器、运行时换成 ``ark``。"""

    app = app_with_principal(principal)
    app.include_router(create_final_cut_project_router(project(ark_translator(ark))))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


def route(conversation_id: uuid.UUID) -> str:
    return f"/conversations/{conversation_id}/final-cut/translations"


WIRE_ENTRIES = [{"id": one.id, "text": one.text} for one in ENTRIES]


async def test_the_route_answers_in_request_order() -> None:
    ark = FakeArk(tag=model_says(("a", "First\nline"), ("b", "Second")))
    async with route_for(OWNER, ark) as client:
        answered = await client.post(
            route(LIVE.id), json={"targetLocale": "en", "entries": WIRE_ENTRIES}
        )

    assert answered.status_code == 200, answered.text
    assert answered.json() == {
        "translations": [{"id": "b", "text": "Second"}, {"id": "a", "text": "First\nline"}]
    }
    (sent,) = ark.tag_requests
    assert "英语" in sent["input"][0]["content"][0]["text"]


@pytest.mark.parametrize(
    ("principal", "conversation_id", "status"),
    [
        pytest.param(STRANGER, LIVE.id, 404, id="stranger"),
        pytest.param(OWNER, DELETED.id, 404, id="owner-deleted-it"),
        pytest.param(GOVERNOR, LIVE.id, 403, id="governor"),
    ],
)
async def test_the_route_refuses_anyone_but_the_owner(
    principal: Principal, conversation_id: uuid.UUID, status: int
) -> None:
    ark = FakeArk()
    async with route_for(principal, ark) as client:
        refused = await client.post(
            route(conversation_id), json={"targetLocale": "en", "entries": WIRE_ENTRIES}
        )

    assert refused.status_code == status, refused.text
    assert ark.tag_requests == []


async def test_the_route_rejects_a_duplicate_id_with_a_readable_422() -> None:
    ark = FakeArk()
    async with route_for(OWNER, ark) as client:
        refused = await client.post(
            route(LIVE.id),
            json={"targetLocale": "en", "entries": [{"id": "a", "text": "一"}] * 2},
        )

    assert refused.status_code == 422, refused.text
    assert refused.json() == {"detail": "entries: id 'a' 重复"}
    assert ark.tag_requests == []


async def test_the_route_asks_for_smaller_batches_when_the_total_is_over() -> None:
    ark = FakeArk()
    async with route_for(OWNER, ark) as client:
        refused = await client.post(
            route(LIVE.id), json={"targetLocale": "en", "entries": full_batch(1)}
        )

    assert refused.status_code == 422, refused.text
    assert refused.json() == {
        "detail": f"entries: 一批最多 {MAX_TRANSLATION_TOTAL_CHARS} 字，"
        f"这一批有 {MAX_TRANSLATION_TOTAL_CHARS + 1} 字，请分批翻译"
    }
    assert ark.tag_requests == []


@pytest.mark.parametrize(
    ("reply", "status", "code"),
    [
        pytest.param(model_unavailable(), 409, "model_unavailable", id="unavailable"),
        pytest.param(httpx.Response(503, text="busy"), 502, "model_call_failed", id="call-failed"),
        pytest.param(httpx.Response(400, text="rejected"), 502, "model_failed", id="rejected"),
        pytest.param(model_says(("a", "only one")), 502, "model_failed", id="missing-entry"),
    ],
)
async def test_the_route_reports_model_problems_with_a_code(
    reply: httpx.Response, status: int, code: str
) -> None:
    async with route_for(OWNER, FakeArk(tag=reply)) as client:
        failed = await client.post(
            route(LIVE.id), json={"targetLocale": "es", "entries": WIRE_ENTRIES}
        )

    assert failed.status_code == status, failed.text
    answer = failed.json()
    assert set(answer) == {"detail", "code"}
    assert answer["code"] == code
    assert "only one" not in answer["detail"] and "busy" not in answer["detail"]
