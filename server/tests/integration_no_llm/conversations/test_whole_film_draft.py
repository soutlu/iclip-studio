from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.conversations.whole_film_schemas import MAX_FILM_CHARS
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob, GenerationOutput
from iclip.domains.generation.schemas import KIND_AUDIO
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import complete, finished, open_conversation
from tests.helpers.generation import make_edit, make_job, make_music, make_upload, video_request
from tests.helpers.render import StubRender, film_file, rewritten
from tests.helpers.whole_film import build_whole_film_app

URL = "/conversations"

NO_DRAFT = {"revision": 0, "html": None, "updatedAt": None}


def draft_url(conversation_id: uuid.UUID | str) -> str:
    return f"{URL}/{conversation_id}/whole-film/draft"


@pytest.fixture
def render() -> StubRender:
    return StubRender()


@pytest.fixture
async def film_app(
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch, render: StubRender
) -> FastAPI:
    return await build_whole_film_app(monkeypatch, engine, render)


@pytest.fixture
async def client(film_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(film_app) as http:
        yield http


@pytest.fixture
def generations(engine: AsyncEngine) -> SqlGenerationRepository:
    return SqlGenerationRepository(engine)


async def new_conversation(client: httpx.AsyncClient) -> uuid.UUID:
    created = await client.post(URL, json={"agentId": "director"})
    assert created.status_code == 201, created.text
    return uuid.UUID(created.json()["conversation"]["id"])


async def save(
    client: httpx.AsyncClient, conversation_id: uuid.UUID, revision: int, html: str
) -> httpx.Response:
    return await client.put(draft_url(conversation_id), json={"revision": revision, "html": html})


def film_of(*takes: GenerationJob, duration_ms: int = 5000) -> str:
    return film_file(*((take.id, take.output.url or "") for take in takes), duration_ms=duration_ms)


async def test_the_owner_saves_by_revision_and_reads_the_rewritten_file_back(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    another = await finished(generations, owner, mine, "another")
    first = film_of(take, another)

    empty = await client.get(draft_url(mine))
    assert (empty.status_code, empty.json()) == (200, NO_DRAFT)
    assert (await save(client, mine, 3, first)).status_code == 409, "还没有草稿只能给 0"

    created = await save(client, mine, 0, first)
    assert created.status_code == 200, created.text
    assert created.json()["revision"] == 1
    read = await client.get(draft_url(mine))
    assert read.status_code == 200, read.text
    assert read.json() == {
        "revision": 1,
        "html": rewritten(first),
        "updatedAt": created.json()["updatedAt"],
    }, "存下的是渲染服务重写后的那一份"

    second = film_of(take, duration_ms=3000)
    updated = await save(client, mine, 1, second)
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    assert datetime.fromisoformat(updated.json()["updatedAt"]) >= datetime.fromisoformat(
        created.json()["updatedAt"]
    )

    for stale in (0, 1, 3):
        assert (await save(client, mine, stale, first)).status_code == 409
    assert (await client.get(draft_url(mine))).json()["html"] == rewritten(second)

    cleared = await save(client, mine, 2, film_of())
    assert cleared.status_code == 200, "一个片段都没有的成片也能存"


async def test_only_the_owner_writes_while_readers_of_the_conversation_read(
    film_app: FastAPI,
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    film = film_of(take)
    assert (await save(client, mine, 0, film)).status_code == 200

    async with make_client(film_app) as governor, make_client(film_app) as stranger:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        await login_as_editor(stranger, pg_url, username="mallory")

        read = await governor.get(draft_url(mine))
        assert (read.status_code, read.json()["html"]) == (200, rewritten(film))
        assert (await save(governor, mine, 1, film)).status_code == 403
        assert (await stranger.get(draft_url(mine))).status_code == 404
        assert (await save(stranger, mine, 1, film)).status_code == 404
    assert (await client.get(draft_url(mine))).json()["revision"] == 1


async def test_a_deleted_conversation_keeps_its_draft_read_only(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository
) -> None:
    owner = uuid.UUID(await register_and_login(client, username="gov", email="gov@example.com"))
    await set_roles_in_db(pg_url, "gov@example.com", ["root"])
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    film = film_of(take)
    assert (await save(client, mine, 0, film)).status_code == 200
    assert (await client.delete(f"{URL}/{mine}")).status_code == 204

    assert (await client.get(draft_url(mine))).json()["html"] == rewritten(film)
    assert (await save(client, mine, 1, film)).status_code == 403


@pytest.mark.parametrize(
    ("html", "reason"),
    [
        pytest.param("<html><script>alert(1)</script></html>", "成片文件不合写法", id="不合写法"),
        pytest.param("", "html", id="空文件"),
        pytest.param("x" * (MAX_FILM_CHARS + 1), "html", id="超过长度上限"),
    ],
)
async def test_a_file_the_render_service_refuses_is_rejected_with_its_reason(
    client: httpx.AsyncClient, pg_url: str, html: str, reason: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await new_conversation(client)

    rejected = await save(client, mine, 0, html)

    assert rejected.status_code == 422
    assert reason in rejected.json()["detail"]
    assert (await client.get(draft_url(mine))).json() == NO_DRAFT


async def test_a_render_outage_is_a_502_and_keeps_the_stored_draft(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    assert (await save(client, mine, 0, film_of(take))).status_code == 200

    render.down = True
    unreachable = await save(client, mine, 1, film_of(take, duration_ms=3000))

    assert unreachable.status_code == 502, unreachable.text
    read = (await client.get(draft_url(mine))).json()
    assert (read["revision"], read["html"]) == (1, rewritten(film_of(take)))


async def test_drafts_cannot_be_saved_without_a_render_service(
    base_env: None,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    render: StubRender,
    pg_url: str,
) -> None:
    unrendered = await build_whole_film_app(monkeypatch, engine, render, render_url=None)
    async with make_client(unrendered) as http:
        await login_as_editor(http, pg_url)
        mine = await new_conversation(http)
        saved = await save(http, mine, 0, film_of())
        read = await http.get(draft_url(mine))

    assert (saved.status_code, saved.json()) == (422, {"detail": "成片没有开通"})
    assert (read.status_code, read.json()) == (200, NO_DRAFT)


@dataclass(frozen=True, slots=True)
class Scene:
    owner: uuid.UUID
    mine: uuid.UUID
    other: uuid.UUID
    take: GenerationJob
    inherited: GenerationJob
    inherited_music: GenerationJob
    repo: SqlGenerationRepository


async def _scene(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
) -> Scene:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    conversations = SqlConversationRepository(engine)
    parent = (await open_conversation(conversations, owner)).id
    inherited = await finished(generations, owner, parent, "before-fork")
    inherited_music = await complete(
        generations,
        await generations.create(make_music(owner_user_id=owner, conversation_id=parent)),
        "https://example.test/before-fork-music.wav",
    )
    mine = (await open_conversation(conversations, owner, forked_from=parent)).id
    other = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    return Scene(owner, mine, other, take, inherited, inherited_music, generations)


Case = Callable[[Scene], Awaitable[str]]


async def own_take(scene: Scene) -> str:
    return film_of(scene.take)


async def inherited_take(scene: Scene) -> str:
    return film_of(scene.inherited)


async def own_and_inherited_takes(scene: Scene) -> str:
    return film_of(scene.take, scene.inherited)


async def other_conversations_take(scene: Scene) -> str:
    theirs = await finished(scene.repo, scene.owner, scene.other, "elsewhere")
    return film_of(theirs)


async def unknown_take(scene: Scene) -> str:
    return film_file((uuid.uuid4(), scene.take.output.url or ""))


async def unfinished_take(scene: Scene) -> str:
    pending = await scene.repo.create(
        make_job(video_request(), owner_user_id=scene.owner, conversation_id=scene.mine)
    )
    return film_file((pending.id, "https://example.test/pending.mp4"))


async def edit_segment(scene: Scene) -> str:
    edit = await scene.repo.create(
        make_edit(scene.take, owner_user_id=scene.owner, conversation_id=scene.mine)
    )
    return film_of(await complete(scene.repo, edit, "https://example.test/edit.mp4"))


async def take_with_another_address(scene: Scene) -> str:
    return film_file((scene.take.id, "https://elsewhere.test/take.mp4"))


async def _music(scene: Scene, conversation: uuid.UUID, name: str) -> GenerationJob:
    job = await scene.repo.create(
        make_music(owner_user_id=scene.owner, conversation_id=conversation)
    )
    return await complete(scene.repo, job, f"https://example.test/{name}.wav")


def with_audio(scene: Scene, audio: GenerationJob, url: str | None = None) -> str:
    return film_file(
        (scene.take.id, scene.take.output.url or ""),
        audios=[(audio.id, url if url is not None else audio.output.url or "")],
    )


async def own_audio(scene: Scene) -> str:
    return with_audio(scene, await _music(scene, scene.mine, "music"))


async def inherited_audio(scene: Scene) -> str:
    return with_audio(scene, scene.inherited_music)


async def own_audio_upload(scene: Scene) -> str:
    upload = await scene.repo.create(
        make_upload(
            kind=KIND_AUDIO,
            owner_user_id=scene.owner,
            conversation_id=scene.mine,
            output=GenerationOutput(url="https://example.test/uploaded.mp3"),
        )
    )
    return with_audio(scene, upload)


async def other_conversations_audio(scene: Scene) -> str:
    return with_audio(scene, await _music(scene, scene.other, "elsewhere-music"))


async def unfinished_audio(scene: Scene) -> str:
    # 带着地址，只有「还没完成」这一条不合
    pending = await scene.repo.create(
        make_music(
            owner_user_id=scene.owner,
            conversation_id=scene.mine,
            output=GenerationOutput(url="https://example.test/pending.wav"),
        )
    )
    return with_audio(scene, pending)


async def take_used_as_audio(scene: Scene) -> str:
    return with_audio(scene, scene.take)


async def audio_with_another_address(scene: Scene) -> str:
    return with_audio(
        scene, await _music(scene, scene.mine, "music"), "https://elsewhere.test/music.wav"
    )


async def audio_used_as_take(scene: Scene) -> str:
    music = await _music(scene, scene.mine, "music")
    return film_file((music.id, music.output.url or ""))


@pytest.mark.parametrize(
    ("case", "accepted"),
    [
        pytest.param(own_audio, True, id="自己的配乐"),
        pytest.param(inherited_audio, True, id="继承来的配乐"),
        pytest.param(own_audio_upload, True, id="关联到这段对话的音频上传"),
        pytest.param(other_conversations_audio, False, id="别的对话的配乐"),
        pytest.param(unfinished_audio, False, id="还没生成完的配乐"),
        pytest.param(take_used_as_audio, False, id="素材片当音频用"),
        pytest.param(audio_with_another_address, False, id="音频地址不是记录上的那个"),
        pytest.param(audio_used_as_take, False, id="音频当素材片用"),
    ],
)
async def test_audio_sources_must_be_finished_audio_of_this_conversation_at_their_own_address(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
    case: Case,
    accepted: bool,
) -> None:
    scene = await _scene(client, pg_url, engine, generations)
    film = await case(scene)

    saved = await save(client, scene.mine, 0, film)

    if accepted:
        assert saved.status_code == 200, saved.text
    else:
        assert saved.status_code == 422, saved.text
        assert (await client.get(draft_url(scene.mine))).json() == NO_DRAFT


@pytest.mark.parametrize(
    ("case", "accepted"),
    [
        pytest.param(own_take, True, id="自己的出片"),
        pytest.param(inherited_take, True, id="继承来的出片"),
        pytest.param(own_and_inherited_takes, True, id="自己的和继承来的一起用"),
        pytest.param(other_conversations_take, False, id="别的对话的出片"),
        pytest.param(unknown_take, False, id="没有这条"),
        pytest.param(unfinished_take, False, id="还没出完的出片"),
        pytest.param(edit_segment, False, id="编辑段不是素材片"),
        pytest.param(take_with_another_address, False, id="地址不是记录上的那个"),
    ],
)
async def test_sources_must_be_takes_of_this_conversation_at_their_own_address(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
    case: Case,
    accepted: bool,
) -> None:
    scene = await _scene(client, pg_url, engine, generations)
    film = await case(scene)

    saved = await save(client, scene.mine, 0, film)

    if accepted:
        assert saved.status_code == 200, saved.text
    else:
        assert saved.status_code == 422, saved.text
        assert (await client.get(draft_url(scene.mine))).json() == NO_DRAFT
