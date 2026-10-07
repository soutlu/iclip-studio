"""验证制作页端点：按对话读 AI 导演的工程，改字与换图带版本写回，权限同工作区文件。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI
from sqlalchemy import text

from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.film import FILM, GIVEN_IMAGES, RUN
from tests.helpers.pg import connected

URL = "/conversations"


async def film_conversation(client: httpx.AsyncClient, pg_url: str) -> str:
    """登录、开一段对话，放进样例工程与它用到的素材，返回对话 id。"""

    user_id = await login_as_editor(client, pg_url)
    created = await client.post(URL, json={"agentId": "director", "title": "跑鞋"})
    conversation = created.json()["conversation"]["id"]
    namespace = f"{user_id}/{conversation}"
    async with connected(pg_url) as conn:
        for path, content in (("film.icml", FILM), ("film.icrun", RUN)):
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.workspace_files "
                    "(namespace, path, content, version, created_at, updated_at) "
                    "VALUES (:ns, :path, :content, 1, now(), now())"
                ),
                {"ns": namespace, "path": path, "content": content},
            )
        for url in GIVEN_IMAGES:
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.materials (namespace, url, kind) "
                    "VALUES (:ns, :url, 'image')"
                ),
                {"ns": namespace, "url": url},
            )
    return conversation


async def test_the_page_reads_the_film_and_writes_edits_with_their_version(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    mine = await film_conversation(client, pg_url)

    read = await client.get(f"{URL}/{mine}/film")
    assert read.status_code == 200, read.text
    film = read.json()["film"]
    assert (film["filmVersion"], film["runVersion"], film["problems"]) == (1, 1, 0)
    (group,) = film["groups"]
    assert (group["aspectRatio"], group["seconds"], group["model"]) == (
        "9:16",
        15,
        "mmt-seedance-2-5",
    )
    assert group["frames"][0] == {
        "node": "短发女生参考图",
        "label": "短发女生",
        "kind": "generated",
        "url": "https://cdn.test/b-fixed.png",
        "number": 1,
    }
    assert group["shots"][0]["lines"][0]["target"] == "line:lighter"

    edited = await client.patch(
        f"{URL}/{mine}/film/text",
        json={"filmVersion": 1, "edits": [{"target": "line:lighter", "text": "So light!"}]},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["film"]["filmVersion"] == 2
    assert edited.json()["film"]["groups"][0]["shots"][0]["lines"][0]["text"] == "So light!"

    stale = await client.patch(
        f"{URL}/{mine}/film/text",
        json={"filmVersion": 1, "edits": [{"target": "line:lighter", "text": "again"}]},
    )
    assert stale.status_code == 409

    empty = await client.patch(
        f"{URL}/{mine}/film/text",
        json={"filmVersion": 2, "edits": [{"target": "line:lighter", "text": " "}]},
    )
    assert (empty.status_code, empty.json()) == (422, {"detail": "台词不能是空的"})

    cleared = await client.put(
        f"{URL}/{mine}/film/image",
        json={"node": "短发女生参考图", "url": None, "filmVersion": 2, "runVersion": 1},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["film"]["runVersion"] == 2
    assert cleared.json()["film"]["groups"][0]["frames"][0]["url"] is None

    foreign = await client.put(
        f"{URL}/{mine}/film/image",
        json={
            "node": "短发女生参考图",
            "url": "https://elsewhere.test/a.png",
            "filmVersion": 2,
            "runVersion": 2,
        },
    )
    assert foreign.status_code == 422
    assert "只能换成这段对话里的图" in foreign.json()["detail"]


async def test_the_page_follows_the_workspace_file_permissions(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    mine = await film_conversation(client, pg_url)
    empty = (await client.post(URL, json={"agentId": "director"})).json()["conversation"]["id"]
    edit = {"filmVersion": 1, "edits": [{"target": "line:lighter", "text": "x"}]}

    assert (await client.get(f"{URL}/{empty}/film")).status_code == 404

    async with make_client(app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        assert (await stranger.get(f"{URL}/{mine}/film")).status_code == 404
        assert (await stranger.patch(f"{URL}/{mine}/film/text", json=edit)).status_code == 404

    async with make_client(app) as governor:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        assert (await governor.get(f"{URL}/{mine}/film")).status_code == 200
        assert (await governor.patch(f"{URL}/{mine}/film/text", json=edit)).status_code == 403

    assert (await client.get(f"{URL}/{mine}/film")).json()["film"]["filmVersion"] == 1


async def test_malformed_page_requests_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    mine = await film_conversation(client, pg_url)

    both = {"target": "line:lighter", "text": "x", "parts": ["x"]}
    bad_edit = await client.patch(
        f"{URL}/{mine}/film/text", json={"filmVersion": 1, "edits": [both]}
    )
    bad_url = await client.put(
        f"{URL}/{mine}/film/image",
        json={"node": "跑鞋照片", "url": "ftp://x/y.png", "filmVersion": 1, "runVersion": 1},
    )

    assert (bad_edit.status_code, bad_url.status_code) == (422, 422)
