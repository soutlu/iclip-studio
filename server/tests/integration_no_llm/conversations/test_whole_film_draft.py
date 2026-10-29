"""成片草稿端点：按版本整份保存与读回、读写权限同工作区文件、引用的记录要是这段对话的。

记录经生成仓储直接落库，媒体生成没开：草稿只读生成记录，不依赖媒体生成。文档自身的每条规则见
单测 ``test_whole_film_document``，这里只走几条确认 422 接上了，含旧形状（转场、片头片尾）的草稿。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob, GenerationOutput
from iclip.domains.generation.schemas import KIND_AUDIO
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import complete, finished, open_conversation
from tests.helpers.generation import (
    make_edit,
    make_job,
    make_music,
    make_subtitle,
    make_upload,
    video_request,
)
from tests.helpers.whole_film import component_clip, draft_document, overlay, video_clip

URL = "/conversations"

NO_DRAFT = {"revision": 0, "document": None, "updatedAt": None}
"""还没存过草稿时 GET 的答复。"""


def draft_url(conversation_id: uuid.UUID | str) -> str:
    return f"{URL}/{conversation_id}/whole-film/draft"


async def new_conversation(client: httpx.AsyncClient) -> uuid.UUID:
    created = await client.post(URL, json={"agentId": "director"})
    assert created.status_code == 201, created.text
    return uuid.UUID(created.json()["conversation"]["id"])


async def save(
    client: httpx.AsyncClient, conversation_id: uuid.UUID, revision: int, document: dict[str, Any]
) -> httpx.Response:
    return await client.put(
        draft_url(conversation_id), json={"revision": revision, "document": document}
    )


@pytest.fixture
def generations(engine: AsyncEngine) -> SqlGenerationRepository:
    return SqlGenerationRepository(engine)


async def test_the_owner_saves_by_revision_and_reads_the_draft_back(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository
) -> None:
    """还没存过读到版本 0 的空草稿；第一次存给 0，之后每次给读到的那一版，答复新版本；旧版本存是
    409、不改草稿。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    subtitle = await generations.create(make_subtitle(take))
    music = await generations.create(make_music(owner_user_id=owner, conversation_id=mine))
    await generations.mark_completed(
        music.id,
        output=GenerationOutput(url="https://example.test/music.m4a", duration_ms=30_000),
        provider_status="succeeded",
    )
    first = draft_document(
        layer0=[
            video_clip("a", start=0, duration=3000, source_job_id=take.id),
            component_clip("c", start=3000, duration=2000, playback_start=500),
            video_clip("b", start=5000, duration=2000, source_job_id=take.id),
        ],
        edits=[{"subtitleJobId": str(subtitle.id), "sentenceIndex": 0, "text": "改过的字"}],
        music={"jobId": str(music.id), "offset": 0, "volume": 0.8},
        overlays=[
            overlay("o1", start=1000, duration=9000, track=1, z_index=1),
            overlay("o2", start=0, duration=2000, track=0, z_index=2),
        ],
    )

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
        "document": first,
        "updatedAt": created.json()["updatedAt"],
    }

    second = draft_document(source_job_id=take.id)
    second["layer0"].pop()
    updated = await save(client, mine, 1, second)
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    assert datetime.fromisoformat(updated.json()["updatedAt"]) >= datetime.fromisoformat(
        created.json()["updatedAt"]
    )

    for stale in (0, 1, 3):
        assert (await save(client, mine, stale, first)).status_code == 409
    assert (await client.get(draft_url(mine))).json()["document"] == second


async def test_only_the_owner_writes_while_readers_of_the_conversation_read(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository
) -> None:
    """治理者读得到别人的草稿、写是 403；读不到这段对话的人读写都是 404。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    document = draft_document(source_job_id=take.id)
    assert (await save(client, mine, 0, document)).status_code == 200

    async with make_client(app) as governor, make_client(app) as stranger:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        await login_as_editor(stranger, pg_url, username="mallory")

        read = await governor.get(draft_url(mine))
        assert (read.status_code, read.json()["document"]) == (200, document)
        assert (await save(governor, mine, 1, document)).status_code == 403
        assert (await stranger.get(draft_url(mine))).status_code == 404
        assert (await save(stranger, mine, 1, document)).status_code == 404
    assert (await client.get(draft_url(mine))).json()["revision"] == 1


async def test_a_deleted_conversation_keeps_its_draft_read_only(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository
) -> None:
    """属主是治理者时删掉的对话仍读得到：草稿照读，但谁都不能再存。"""

    owner = uuid.UUID(await register_and_login(client, username="gov", email="gov@example.com"))
    await set_roles_in_db(pg_url, "gov@example.com", ["root"])
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    document = draft_document(source_job_id=take.id)
    assert (await save(client, mine, 0, document)).status_code == 200
    assert (await client.delete(f"{URL}/{mine}")).status_code == 204

    assert (await client.get(draft_url(mine))).json()["document"] == document
    assert (await save(client, mine, 1, document)).status_code == 403


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param(
            "layer0",
            [video_clip("a", start=500, duration=1000, source_job_id=uuid.uuid4())],
            id="没有从 0 起",
        ),
        pytest.param("transitions", [], id="带转场"),
        pytest.param(
            "layer0",
            [{**component_clip("c", start=0, duration=1000), "role": "intro"}],
            id="组件段带 role",
        ),
        pytest.param(
            "overlays",
            [
                overlay("o1", start=0, duration=2000, track=0),
                overlay("o2", start=1000, duration=2000, track=0),
            ],
            id="同一行的特效块重叠",
        ),
    ],
)
async def test_an_invalid_document_is_rejected_with_its_reason(
    client: httpx.AsyncClient, pg_url: str, field: str, value: object
) -> None:
    await login_as_editor(client, pg_url)
    mine = await new_conversation(client)
    document = draft_document()
    document[field] = value

    rejected = await save(client, mine, 0, document)

    assert rejected.status_code == 422
    assert rejected.json()["detail"].startswith("document")
    assert (await client.get(draft_url(mine))).json() == NO_DRAFT


@dataclass(frozen=True, slots=True)
class Scene:
    """一个人名下的三段对话：``mine`` 是从另一段分叉出来的，``other`` 是不相干的。"""

    owner: uuid.UUID
    mine: uuid.UUID
    other: uuid.UUID
    take: GenerationJob
    """``mine`` 自己的一条出片，默认画面轨出自它。"""
    inherited: GenerationJob
    """源对话在分叉之前完成的出片，``mine`` 继承得到。"""
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
    mine = (await open_conversation(conversations, owner, forked_from=parent)).id
    other = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    return Scene(owner, mine, other, take, inherited, generations)


async def _completed_music(scene: Scene, conversation_id: uuid.UUID) -> uuid.UUID:
    music = await scene.repo.create(
        make_music(owner_user_id=scene.owner, conversation_id=conversation_id)
    )
    await scene.repo.mark_completed(
        music.id,
        output=GenerationOutput(url=f"https://example.test/{music.id}.m4a", duration_ms=30_000),
        provider_status="succeeded",
    )
    return music.id


Case = Callable[[Scene], Awaitable[dict[str, Any]]]


async def own_take(scene: Scene) -> dict[str, Any]:
    return draft_document(source_job_id=scene.take.id)


async def inherited_take(scene: Scene) -> dict[str, Any]:
    return draft_document(source_job_id=scene.inherited.id)


async def other_conversations_take(scene: Scene) -> dict[str, Any]:
    theirs = await finished(scene.repo, scene.owner, scene.other, "elsewhere")
    return draft_document(source_job_id=theirs.id)


async def unknown_take(_scene: Scene) -> dict[str, Any]:
    return draft_document(source_job_id=uuid.uuid4())


async def unfinished_take(scene: Scene) -> dict[str, Any]:
    pending = await scene.repo.create(
        make_job(video_request(), owner_user_id=scene.owner, conversation_id=scene.mine)
    )
    return draft_document(source_job_id=pending.id)


async def edit_segment(scene: Scene) -> dict[str, Any]:
    edit = await scene.repo.create(
        make_edit(scene.take, owner_user_id=scene.owner, conversation_id=scene.mine)
    )
    await complete(scene.repo, edit, "https://example.test/edit.mp4")
    return draft_document(source_job_id=edit.id)


async def generated_music(scene: Scene) -> dict[str, Any]:
    music = await _completed_music(scene, scene.mine)
    return draft_document(
        source_job_id=scene.take.id, music={"jobId": str(music), "offset": 0, "volume": 1}
    )


async def uploaded_music(scene: Scene) -> dict[str, Any]:
    upload = await scene.repo.create_settled(
        [make_upload(kind=KIND_AUDIO, owner_user_id=scene.owner, conversation_id=scene.mine)]
    )
    return draft_document(
        source_job_id=scene.take.id,
        music={"jobId": str(upload[0].id), "offset": 0, "volume": 1},
    )


async def other_conversations_music(scene: Scene) -> dict[str, Any]:
    music = await _completed_music(scene, scene.other)
    return draft_document(
        source_job_id=scene.take.id, music={"jobId": str(music), "offset": 0, "volume": 1}
    )


async def unfinished_music(scene: Scene) -> dict[str, Any]:
    music = await scene.repo.create(
        make_music(owner_user_id=scene.owner, conversation_id=scene.mine)
    )
    return draft_document(
        source_job_id=scene.take.id, music={"jobId": str(music.id), "offset": 0, "volume": 1}
    )


async def video_as_music(scene: Scene) -> dict[str, Any]:
    return draft_document(
        source_job_id=scene.take.id, music={"jobId": str(scene.take.id), "offset": 0, "volume": 1}
    )


def _edited(scene: Scene, subtitle_id: uuid.UUID, *, source: uuid.UUID) -> dict[str, Any]:
    return draft_document(
        source_job_id=source,
        edits=[{"subtitleJobId": str(subtitle_id), "sentenceIndex": 0, "text": "改过的字"}],
    )


async def subtitle_of_inherited_take(scene: Scene) -> dict[str, Any]:
    subtitle = await scene.repo.create(make_subtitle(scene.inherited))
    return _edited(scene, subtitle.id, source=scene.inherited.id)


async def subtitle_of_a_take_off_the_track(scene: Scene) -> dict[str, Any]:
    """改过字的那条素材片的片段都从画面轨删掉了，改字还留在草稿里。"""

    another = await finished(scene.repo, scene.owner, scene.mine, "another")
    subtitle = await scene.repo.create(make_subtitle(another))
    return _edited(scene, subtitle.id, source=scene.take.id)


async def subtitle_of_other_conversations_take(scene: Scene) -> dict[str, Any]:
    theirs = await finished(scene.repo, scene.owner, scene.other, "elsewhere")
    subtitle = await scene.repo.create(make_subtitle(theirs))
    return _edited(scene, subtitle.id, source=scene.take.id)


async def unknown_subtitle(scene: Scene) -> dict[str, Any]:
    return _edited(scene, uuid.uuid4(), source=scene.take.id)


async def video_as_subtitle(scene: Scene) -> dict[str, Any]:
    return _edited(scene, scene.take.id, source=scene.take.id)


@pytest.mark.parametrize(
    ("case", "accepted"),
    [
        pytest.param(own_take, True, id="自己的出片"),
        pytest.param(inherited_take, True, id="继承来的出片"),
        pytest.param(other_conversations_take, False, id="别的对话的出片"),
        pytest.param(unknown_take, False, id="没有这条"),
        pytest.param(unfinished_take, False, id="还没出完的出片"),
        pytest.param(edit_segment, False, id="编辑段不是素材片"),
        pytest.param(generated_music, True, id="生成的音乐"),
        pytest.param(uploaded_music, True, id="挂到这段对话的上传音乐"),
        pytest.param(other_conversations_music, False, id="别的对话的音乐"),
        pytest.param(unfinished_music, False, id="还没生成完的音乐"),
        pytest.param(video_as_music, False, id="视频当音乐"),
        pytest.param(subtitle_of_inherited_take, True, id="继承来的出片的字幕"),
        pytest.param(subtitle_of_a_take_off_the_track, True, id="不在画面轨里的出片的字幕"),
        pytest.param(subtitle_of_other_conversations_take, False, id="别的对话的出片的字幕"),
        pytest.param(unknown_subtitle, False, id="没有这条字幕"),
        pytest.param(video_as_subtitle, False, id="视频当字幕"),
    ],
)
async def test_references_must_be_records_of_this_conversation(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
    case: Case,
    accepted: bool,
) -> None:
    scene = await _scene(client, pg_url, engine, generations)
    document = await case(scene)

    saved = await save(client, scene.mine, 0, document)

    if accepted:
        assert saved.status_code == 200, saved.text
    else:
        assert saved.status_code == 422, saved.text
        assert (await client.get(draft_url(scene.mine))).json() == NO_DRAFT
