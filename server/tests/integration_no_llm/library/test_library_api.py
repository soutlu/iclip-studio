"""资料库端点：持 ``generation:read`` 就能看全站的素材卡与成片卡连同来源对话，打不打得开对话按对话
自己的可读范围。"""

from __future__ import annotations

import json
import uuid

import httpx
from sqlalchemy import text

from iclip.common.shot_prompt import format_shot_prompt
from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.render import PROVIDER_NAME as RENDER_PROVIDER
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_GENERATE,
    OPERATION_RENDER,
    VideoGenerationIn,
    VideoShotIn,
    request_to_payload,
)
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.generation import whole_film_request
from tests.helpers.pg import connected

VIDEOS = "/library/videos"
AUTHORS = "/library/authors"
WHOLE_FILMS = "/library/whole-films"
WHOLE_FILM_AUTHORS = "/library/whole-films/authors"
PASSWORD = "password-123"

SHOT = VideoShotIn.model_validate(
    {
        "global_settings": "海边木栈道，午后逆光。",
        "timeline": [{"timestamps": [0, 3], "prompt": "模特走向镜头。", "image_indexes": []}],
    }
)
"""种进去的出片带的结构化镜头组。"""


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> uuid.UUID:
    email = f"{username}@example.com"
    user_id = await register_and_login(client, username=username, email=email, password=PASSWORD)
    await set_roles_in_db(pg_url, email, [role])
    return uuid.UUID(user_id)


async def login_again(client: httpx.AsyncClient, username: str) -> None:
    logged_in = await client.post("/auth/login", data={"username": username, "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text


async def plant_video(
    pg_url: str, *, owner: uuid.UUID, user_name: str
) -> tuple[uuid.UUID, uuid.UUID]:
    """一段对话下一条成了的镜 1 出片，请求带 ``SHOT``；返回（对话 id，出片 id）。"""

    conversation_id, video_id = uuid.uuid4(), uuid.uuid4()
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
                " updated_at) VALUES (:id, :owner, 'storyboard', '凉鞋合集', now(), now())"
            ),
            {"id": conversation_id, "owner": owner},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, shot_index, output, created_at,"
                " finished_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
                " CAST(:request AS jsonb), :status, 1,"
                " jsonb_build_object('url', 'https://oss.example.test/v.mp4'), now(), now())"
            ),
            {
                "id": video_id,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_GENERATE,
                "request": json.dumps(
                    request_to_payload(VideoGenerationIn(model="m", shot=SHOT, user_name=user_name))
                ),
                "status": STATUS_COMPLETED,
            },
        )
    return conversation_id, video_id


async def mark_deleted(pg_url: str, conversation_id: uuid.UUID) -> None:
    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.conversations SET deleted_at = now() WHERE id = :id"),
            {"id": conversation_id},
        )


async def detach(pg_url: str, video_id: uuid.UUID) -> None:
    """把出片从对话上摘下来：它成了一张不挂对话的卡，卡 id 是出片 id。"""

    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.generation_jobs SET conversation_id = NULL WHERE id = :id"),
            {"id": video_id},
        )


async def plant_file(pg_url: str, owner: uuid.UUID, conversation_id: uuid.UUID, path: str) -> None:
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.workspace_files"
                " (namespace, path, content, version, created_at, updated_at)"
                " VALUES (:ns, :path, 'x', 1, now(), now())"
            ),
            {"ns": f"{owner}/{conversation_id}", "path": path},
        )


async def plant_whole_film(
    pg_url: str, *, owner: uuid.UUID, conversation_id: uuid.UUID, sources: list[uuid.UUID]
) -> uuid.UUID:
    """``conversation_id`` 上一次完成的成片导出，画面轨按先后用到 ``sources``；返回成片记录 id。"""

    film = uuid.uuid4()
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, output, created_at, finished_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, :operation, :provider,"
                " CAST(:request AS jsonb), :status,"
                " jsonb_build_object('url', CAST(:output_url AS text)), now(), now())"
            ),
            {
                "id": film,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": KIND_WHOLE_FILM,
                "operation": OPERATION_RENDER,
                "provider": RENDER_PROVIDER,
                "request": json.dumps(request_to_payload(whole_film_request(*sources))),
                "status": STATUS_COMPLETED,
                "output_url": f"https://oss.example.test/{film}.mp4",
            },
        )
    return film


async def test_anonymous_is_401(client: httpx.AsyncClient) -> None:
    for path in (VIDEOS, f"{VIDEOS}/{uuid.uuid4()}", AUTHORS, WHOLE_FILMS, WHOLE_FILM_AUTHORS):
        assert (await client.get(path)).status_code == 401


async def test_whole_films_need_generation_read(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "nobody", "viewer")
    await set_roles_in_db(pg_url, "nobody@example.com", [])

    assert (await client.get(WHOLE_FILMS)).status_code == 403
    assert (await client.get(WHOLE_FILM_AUTHORS)).status_code == 403


async def test_whole_film_authors_count_whole_film_cards_by_conversation_owner(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """成片卡的作者是对话属主：Lena 记在 Nora 对话上的导出仍算 Nora 的卡；只有素材片没有导出的对话
    不算。"""

    nora = await login_as(client, pg_url, "nora", "editor")
    nora_conversation, nora_video = await plant_video(pg_url, owner=nora, user_name="nora")
    await plant_video(pg_url, owner=nora, user_name="nora")
    lena = await login_as(client, pg_url, "lena", "editor")
    for _ in range(2):
        conversation, video = await plant_video(pg_url, owner=lena, user_name="lena")
        await plant_whole_film(pg_url, owner=lena, conversation_id=conversation, sources=[video])
    await plant_whole_film(
        pg_url, owner=lena, conversation_id=nora_conversation, sources=[nora_video]
    )

    film_authors = await client.get(WHOLE_FILM_AUTHORS)
    card_authors = await client.get(AUTHORS)

    assert film_authors.status_code == 200, film_authors.text
    assert film_authors.json() == {
        "items": [{"userName": "lena", "count": 2}, {"userName": "nora", "count": 1}]
    }
    assert card_authors.json() == {
        "items": [{"userName": "lena", "count": 2}, {"userName": "nora", "count": 2}]
    }


async def test_whole_film_cards_carry_every_version_and_the_conversation(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """属主看到自己的成片卡、打得开对话；同事看到同一张卡，打不开对话。卡面是最后一版，每版带用到的
    素材片，没有水印版与时长。"""

    owner = await login_as(client, pg_url, "nora", "editor")
    conversation_id, video_id = await plant_video(pg_url, owner=owner, user_name="nora")
    first = await plant_whole_film(
        pg_url, owner=owner, conversation_id=conversation_id, sources=[video_id]
    )
    second = await plant_whole_film(
        pg_url, owner=owner, conversation_id=conversation_id, sources=[]
    )

    as_owner = await client.get(WHOLE_FILMS)
    await login_as(client, pg_url, "lena", "editor")
    as_colleague = await client.get(WHOLE_FILMS)

    assert as_owner.status_code == 200, as_owner.text
    body = as_owner.json()
    assert body["total"] == 1 and body["nextCursor"] is None
    card = body["items"][0]
    assert set(card) == {
        "conversationId",
        "canOpenConversation",
        "title",
        "userName",
        "face",
        "versions",
    }
    assert (card["conversationId"], card["title"], card["userName"]) == (
        str(conversation_id),
        "凉鞋合集",
        "nora",
    )
    assert card["canOpenConversation"] is True
    assert [version["jobId"] for version in card["versions"]] == [str(first), str(second)]
    assert card["versions"][0]["sourceJobIds"] == [str(video_id)]
    assert card["face"] == card["versions"][-1]
    assert card["face"] == {
        "jobId": str(second),
        "outputUrl": f"https://oss.example.test/{second}.mp4",
        "finishedAt": card["face"]["finishedAt"],
        "userName": "nora",
        "sourceJobIds": [],
    }

    colleague = as_colleague.json()["items"][0]
    assert colleague["canOpenConversation"] is False
    assert {**colleague, "canOpenConversation": True} == card


async def test_viewer_reads_the_empty_library(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "viewer", "viewer")

    videos = await client.get(VIDEOS)
    authors = await client.get(AUTHORS)
    films = await client.get(WHOLE_FILMS)
    film_authors = await client.get(WHOLE_FILM_AUTHORS)
    missing = await client.get(f"{VIDEOS}/{uuid.uuid4()}")

    assert videos.status_code == 200, videos.text
    assert videos.json() == {"items": [], "nextCursor": None, "total": 0}
    assert authors.json() == {"items": []}
    assert films.json() == {"items": [], "nextCursor": None, "total": 0}
    assert film_authors.json() == {"items": []}
    assert missing.status_code == 404


async def test_everyone_gets_the_conversation_only_readers_can_open_it(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """卡 id 就是对话 id，人人拿得到对话；打不打得开按对话的可读范围，删了只剩治理者打得开。
    作者按属主，不看请求里的名字。"""

    owner = await login_as(client, pg_url, "nora", "editor")
    conversation_id, video_id = await plant_video(pg_url, owner=owner, user_name="someone-else")
    card = f"{VIDEOS}/{conversation_id}"

    as_owner = await client.get(card)
    await login_as(client, pg_url, "lena", "editor")
    as_colleague = await client.get(card)
    listed = (await client.get(VIDEOS)).json()
    await login_as(client, pg_url, "boss", "root")
    as_governor = await client.get(card)
    by_take = await client.get(f"{VIDEOS}/{video_id}")
    await mark_deleted(pg_url, conversation_id)
    governor_after_delete = await client.get(card)
    await login_again(client, "nora")
    owner_after_delete = await client.get(card)

    assert as_owner.status_code == 200, as_owner.text
    detail = as_owner.json()
    video = detail["video"]
    assert video["id"] == video["conversationId"] == str(conversation_id)
    assert video["canOpenConversation"] is True and video["userName"] == "nora"
    assert [
        (group["shotIndex"], [(v["kind"], v["jobId"], v["userName"]) for v in group["versions"]])
        for group in detail["groups"]
    ] == [(1, [("take", str(video_id), "nora")])]
    assert video["take"]["script"] == {
        "globalSettings": "海边木栈道，午后逆光。",
        "timeline": [{"start": 0, "end": 3, "prompt": "模特走向镜头。", "imageIndexes": []}],
    }

    colleague = as_colleague.json()["video"]
    assert colleague["conversationId"] == str(conversation_id)
    assert colleague["canOpenConversation"] is False
    assert colleague["title"] == "凉鞋合集"
    assert colleague["take"]["prompt"] == format_shot_prompt(SHOT)
    assert colleague["take"] == video["take"], "同事与属主拿到同一份参数与脚本"
    assert [(item["id"], item["canOpenConversation"]) for item in listed["items"]] == [
        (str(conversation_id), False)
    ]
    assert listed["total"] == 1

    assert as_governor.json()["video"]["canOpenConversation"] is True
    assert by_take.status_code == 404
    assert governor_after_delete.json()["video"]["canOpenConversation"] is True
    assert owner_after_delete.status_code == 200
    assert owner_after_delete.json()["video"]["canOpenConversation"] is False


async def test_can_make_same_needs_a_conversation_with_a_film_or_shot_file(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """做得了同款：卡挂着对话、工作区里有 ``film.icml`` 或 ``video_shot.json``；不看读者打不打得开
    那段对话、它删没删。"""

    owner = await login_as(client, pg_url, "nora", "editor")
    with_film, _ = await plant_video(pg_url, owner=owner, user_name="nora")
    with_shots, _ = await plant_video(pg_url, owner=owner, user_name="nora")
    without, _ = await plant_video(pg_url, owner=owner, user_name="nora")
    was_in, orphan = await plant_video(pg_url, owner=owner, user_name="nora")
    await plant_file(pg_url, owner, with_film, "film.icml")
    await plant_file(pg_url, owner, with_shots, "video_shot.json")
    for path in ("brief.md", "treatment.md", "film.icrun", "old_film.icml"):
        await plant_file(pg_url, owner, without, path)
    await plant_file(pg_url, owner, was_in, "film.icml")
    await detach(pg_url, orphan)

    async def can_make_same(card_id: uuid.UUID) -> bool:
        detail = await client.get(f"{VIDEOS}/{card_id}")
        assert detail.status_code == 200, detail.text
        return detail.json()["canMakeSame"]

    assert await can_make_same(with_film) is True
    assert await can_make_same(with_shots) is True
    assert await can_make_same(without) is False, "别的文件都不算"
    assert await can_make_same(orphan) is False, "不挂对话的卡没有对话可拷"

    await login_as(client, pg_url, "lena", "editor")
    detail = (await client.get(f"{VIDEOS}/{with_film}")).json()
    assert detail["video"]["canOpenConversation"] is False
    assert detail["canMakeSame"] is True, "打不开那段对话也做得了"
    await mark_deleted(pg_url, with_film)
    assert await can_make_same(with_film) is True, "删了也做得了"


async def test_bad_parameters_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    await login_as(client, pg_url, "viewer", "viewer")

    inverted = await client.get(
        VIDEOS, params={"since": "2026-09-02T00:00:00Z", "until": "2026-09-01T00:00:00Z"}
    )
    bad_cursor = await client.get(VIDEOS, params={"cursor": "not-a-cursor"})
    bad_orientation = await client.get(VIDEOS, params={"orientation": "square"})

    assert inverted.status_code == 422 and "since" in inverted.json()["detail"]
    assert bad_cursor.status_code == 422 and "cursor" in bad_cursor.json()["detail"]
    assert bad_orientation.status_code == 422

    film_inverted = await client.get(
        WHOLE_FILMS, params={"since": "2026-09-02T00:00:00Z", "until": "2026-09-01T00:00:00Z"}
    )
    film_bad_cursor = await client.get(WHOLE_FILMS, params={"cursor": "not-a-cursor"})
    assert film_inverted.status_code == 422 and "since" in film_inverted.json()["detail"]
    assert film_bad_cursor.status_code == 422 and "cursor" in film_bad_cursor.json()["detail"]
