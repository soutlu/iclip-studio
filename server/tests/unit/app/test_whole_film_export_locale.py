"""按语言导出成片，不连库的部分：请求体、发起时查值表、记录里的语言、最近一次导出的答复、交给渲染服务的请求体。
连库的整条流程见 ``tests/integration_no_llm/conversations/test_whole_film_export.py``。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, NoReturn, cast

import pytest
from pydantic import ValidationError

from iclip.app.whole_film_exports import WholeFilmExportAdapter
from iclip.common.errors import NotFound, ValidationFailed
from iclip.common.final_cut import TargetLocale
from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.repository import AgentPreviewStore, ConversationRepository
from iclip.domains.conversations.service import (
    ConversationService,
    DerivedFileContent,
    RuntimeSessions,
    SameStyleFiles,
)
from iclip.domains.conversations.whole_film_schemas import WholeFilmExportIn
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationJob, GenerationOutput
from iclip.domains.generation.render import (
    ProjectFile,
    RenderClient,
    RenderProvider,
    RenderSetup,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import WholeFilmRequest
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.domains.references.infra_sql import SqlReferenceLookup
from iclip.domains.uploads.service import UploadService
from iclip.platform.object_store.store import SignedUpload
from tests.helpers.film import UnusedFilmPage
from tests.helpers.generation import FixedLineage, make_job
from tests.helpers.render import StubRender

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
OWNER = Principal(
    kind="user", user_id=uuid.uuid4(), permissions=frozenset({"agent:run"}), audit_label="logan"
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
MAIN = "<!doctype html><html><head></head><body></body></html>"


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("这里用不到这个端口")


class OneConversation:
    async def get(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None, include_deleted: bool = False
    ) -> Conversation:
        if conversation_id != LIVE.id or owner not in (None, LIVE.owner_user_id):
            raise NotFound("没有这段对话")
        return LIVE


class RecordingExports:
    def __init__(self) -> None:
        self.started: list[tuple[str, TargetLocale | None]] = []

    async def start(
        self,
        principal: Principal,
        *,
        conversation_id: uuid.UUID,
        main_file: str,
        locale: TargetLocale | None,
    ) -> uuid.UUID:
        self.started.append((main_file, locale))
        return uuid.uuid4()

    async def latest(self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID) -> None:
        raise AssertionError("这里不读导出")

    async def cancel(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID, export_id: uuid.UUID
    ) -> None:
        raise AssertionError("这里不取消导出")


def service_with(files: dict[str, str], exports: RecordingExports) -> ConversationService:
    """工作区里只有 ``files``（工作区路径 → 内容）的一段对话。"""

    async def read_file(
        owner: uuid.UUID, conversation_id: uuid.UUID, path: str
    ) -> DerivedFileContent | None:
        content = files.get(path)
        return (
            None if content is None else DerivedFileContent(path=path, content=content, version=1)
        )

    return ConversationService(
        cast("ConversationRepository", OneConversation()),
        previews=cast("AgentPreviewStore", object()),
        runtime=cast("RuntimeSessions", object()),
        list_collections=_untouched,
        claim_task=_untouched,
        task_exists=_untouched,
        collection_exists=_untouched,
        list_derived_files=_untouched,
        read_derived_file=read_file,
        write_derived_file=_untouched,
        document_validators={},
        film=UnusedFilmPage(),
        exports=exports,
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


@pytest.mark.parametrize(
    ("body", "locale"),
    [
        pytest.param({}, None, id="no-locale"),
        pytest.param({"locale": None}, None, id="null-locale"),
        pytest.param({"locale": "en"}, "en", id="english"),
        pytest.param({"locale": "fr"}, "fr", id="french"),
        pytest.param({"locale": "zh"}, "zh", id="chinese"),
    ],
)
def test_the_request_body_names_a_locale_or_none_for_the_source(
    body: dict[str, Any], locale: TargetLocale | None
) -> None:
    assert WholeFilmExportIn.model_validate(body).locale == locale


@pytest.mark.parametrize("locale", ["ja", "ZH", "EN", ""])
def test_a_locale_the_editor_does_not_support_is_refused(locale: str) -> None:
    with pytest.raises(ValidationError):
        WholeFilmExportIn.model_validate({"locale": locale})


async def test_a_locale_export_starts_when_the_project_has_that_locales_table() -> None:
    exports = RecordingExports()
    service = service_with(
        {
            "final-cut/index.html": MAIN,
            "final-cut/locales/en.json": "{}",
            "final-cut/locales/zh.json": "{}",
        },
        exports,
    )

    await service.export_whole_film(OWNER, LIVE.id, locale="en")
    await service.export_whole_film(OWNER, LIVE.id, locale="zh")
    await service.export_whole_film(OWNER, LIVE.id, locale=None)

    assert exports.started == [(MAIN, "en"), (MAIN, "zh"), (MAIN, None)]


async def test_a_locale_export_without_that_locales_table_is_refused_before_recording() -> None:
    exports = RecordingExports()
    service = service_with(
        {"final-cut/index.html": MAIN, "final-cut/locales/en.json": "{}"}, exports
    )

    with pytest.raises(ValidationFailed) as refused:
        await service.export_whole_film(OWNER, LIVE.id, locale="de")

    assert str(refused.value) == "final-cut 里没有这种语言的语言文件，无法导出这种语言的版本"
    assert exports.started == []


class RecordingGeneration:
    def __init__(self) -> None:
        self.requests: list[WholeFilmRequest] = []

    async def submit_whole_film(
        self, principal: Principal, *, conversation_id: uuid.UUID, request: WholeFilmRequest
    ) -> GenerationJob:
        self.requests.append(request)
        return make_job(request, conversation_id=conversation_id)


class Generations:
    """生成记录的仓储：对不上任何素材，最近一次导出是 ``latest``。"""

    def __init__(self, latest: GenerationJob | None = None) -> None:
        self._latest = latest

    async def earliest_by_outputs(self, urls: Sequence[str]) -> dict[str, GenerationJob]:
        return {}

    async def list_for_owner(self, **_: object) -> list[GenerationJob]:
        return [] if self._latest is None else [self._latest]


class Uploads:
    """上传：对不上任何素材。"""

    async def conversation_uploads_at(
        self, conversation_id: uuid.UUID, urls: Sequence[str]
    ) -> dict[str, object]:
        return {}


class References:
    """参考音频库：对不上任何素材。"""

    async def audio_ids_at(self, urls: Sequence[str]) -> dict[str, uuid.UUID]:
        return {}


def adapter(generation: RecordingGeneration, generations: Generations) -> WholeFilmExportAdapter:
    return WholeFilmExportAdapter(
        generation=cast("GenerationService", generation),
        generations=cast("GenerationRepository", generations),
        uploads=cast("UploadService", Uploads()),
        references=cast("SqlReferenceLookup", References()),
        lineage=FixedLineage(),
        render=cast("RenderClient", object()),
    )


@pytest.mark.parametrize("locale", ["de", None])
async def test_the_record_keeps_the_locale_and_the_latest_export_answers_with_it(
    locale: TargetLocale | None,
) -> None:
    generation = RecordingGeneration()

    await adapter(generation, Generations()).start(
        OWNER, conversation_id=LIVE.id, main_file=MAIN, locale=locale
    )
    (request,) = generation.requests
    assert request.locale == locale

    done = make_job(
        request,
        conversation_id=LIVE.id,
        status=STATUS_COMPLETED,
        output=GenerationOutput(url="https://cdn.test/whole-films/a.mp4"),
    )
    shown = await adapter(generation, Generations(done)).latest(
        conversation_id=LIVE.id, owner_user_id=OWNER.user_id
    )
    assert shown is not None
    assert (shown.locale, shown.status) == (locale, "done")


class Signer:
    def sign_server_upload(
        self, *, object_key: str, content_type: str, expires_seconds: int
    ) -> SignedUpload:
        return SignedUpload(url=f"https://oss.test/{object_key}", headers={})


@pytest.mark.parametrize("locale", ["es", None])
async def test_the_render_service_is_told_which_locale_to_render(
    locale: TargetLocale | None,
) -> None:
    render = StubRender()

    async def read_project(owner: uuid.UUID, conversation: uuid.UUID) -> Sequence[ProjectFile]:
        return [ProjectFile(path="index.html", content=MAIN)]

    provider = RenderProvider(
        RenderSetup(
            client=RenderClient("http://render:8080", transport=render.transport()),
            uploads=Signer(),
            public_url=lambda key: f"https://cdn.test/{key}",
            read_project=read_project,
        ),
        fetch_url=lambda url: url,
    )
    job = make_job(WholeFilmRequest(videos=[], audios=[], locale=locale), conversation_id=LIVE.id)

    await provider.submit(job)

    (payload,) = render.submitted
    assert "locale" in payload, "原文也带上这个键，写 null"
    assert payload["locale"] == locale
