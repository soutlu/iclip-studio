"""验证制作页端点：按对话读 AI 导演的工程，改字与换图带版本写回，权限同工作区文件。"""

from __future__ import annotations

import httpx
from fastapi import FastAPI
from sqlalchemy import text

from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.film import EXPECTED, FILM, GIVEN_IMAGES, PHOTOS, RUN, run_of
from tests.helpers.pg import connected

URL = "/conversations"
FIRST_SHOT = [
    "参考@Image8，中景，平视，手持跟拍。模特A和模特B在红砖街区的人行道上并肩走向镜头。"
    "模特A低头看鞋说：",
    " 模特B侧头问：",
    " 音效：两人的脚步声与街道环境声。",
]


def say(version: int, text: str) -> dict[str, object]:
    """改第一个镜头里第一句台词的请求体。"""

    lines = [
        {"target": "line:hook", "text": text},
        {"target": "line:reply", "text": "鞋底是软的吗？"},
    ]
    edit = {"target": "shot:video01Shots:1", "parts": FIRST_SHOT, "lines": lines}
    return {"filmVersion": version, "edits": [edit]}


async def film_conversation(client: httpx.AsyncClient, pg_url: str, run: str = RUN) -> str:
    """登录、开一段对话，放进样例工程与它用到的素材，返回对话 id。"""

    user_id = await login_as_editor(client, pg_url)
    created = await client.post(URL, json={"agentId": "director", "title": "鞋款"})
    conversation = created.json()["conversation"]["id"]
    namespace = f"{user_id}/{conversation}"
    async with connected(pg_url) as conn:
        for path, content in (("film.icml", FILM), ("film.icrun", run)):
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
    mine = await film_conversation(client, pg_url, run_of("no-personB"))

    read = await client.get(f"{URL}/{mine}/film")
    assert read.status_code == 200, read.text
    film = read.json()["film"]
    assert (film["filmVersion"], film["runVersion"], film["problems"]) == (1, 1, 0)
    group, _ = film["groups"]
    assert (group["aspectRatio"], group["seconds"], group["model"]) == (
        "16:9",
        18,
        "mmt-seedance-2-5",
    )
    # 缺图的这组照样带着它发给视频模型的正文。
    settings = EXPECTED["states"]["both"]["video01"]["shot"]["global_settings"]
    assert group["prompt"].startswith(f"{settings}\n\n镜头：\n0–6秒 参考@Image8，")
    person = group["frames"][2]
    assert {key: value for key, value in person.items() if key != "prompt"} == {
        "node": "personB",
        "label": "personB",
        "kind": "generated",
        "url": None,
        "number": 3,
        "aspectRatio": "3:4",
        "missing": [],
    }
    assert person["prompt"] == [{"kind": "text", "text": EXPECTED["images"]["personB"]["prompt"]}]
    first_view = group["frames"][7]
    assert (first_view["label"], first_view["missing"]) == ("镜头 1", ["personB"])
    # 描述里没图的那张也是图片段：带它在这张图自己列表里的编号，地址为 null。
    cited = [run for run in first_view["prompt"] if run["kind"] == "image"]
    assert cited[2] == {
        "kind": "image",
        "node": "personB",
        "label": "personB",
        "url": None,
        "number": 3,
    }
    shoe_setting = group["settings"][3]
    assert (shoe_setting["kind"], shoe_setting["label"], shoe_setting["images"]) == (
        "element",
        "产品",
        [],
    )
    photo = group["frames"][0]
    assert (photo["kind"], photo["url"], photo["prompt"], photo["aspectRatio"]) == (
        "photo",
        PHOTOS["modelAPortraitPhoto"],
        None,
        None,
    )
    assert group["shots"][0]["lines"][0]["target"] == "line:hook"

    edited = await client.patch(
        f"{URL}/{mine}/film/text",
        json=say(1, "这一双，真轻。"),
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["film"]["filmVersion"] == 2
    assert edited.json()["film"]["groups"][0]["shots"][0]["lines"][0]["text"] == "这一双，真轻。"

    stale = await client.patch(
        f"{URL}/{mine}/film/text",
        json=say(1, "again"),
    )
    assert stale.status_code == 409

    empty = await client.patch(
        f"{URL}/{mine}/film/text",
        json=say(2, " "),
    )
    assert (empty.status_code, empty.json()) == (422, {"detail": "台词不能是空的"})

    cleared = await client.put(
        f"{URL}/{mine}/film/image",
        json={"node": "scene", "url": None, "filmVersion": 2, "runVersion": 1},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["film"]["runVersion"] == 2
    assert cleared.json()["film"]["groups"][0]["frames"][6]["url"] is None

    foreign = await client.put(
        f"{URL}/{mine}/film/image",
        json={
            "node": "scene",
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
    edit = say(1, "x")

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


async def test_an_image_inserted_into_the_text_joins_the_list_before_the_views(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    mine = await film_conversation(client, pg_url)
    corner = "https://cdn.test/corner.jpg"
    async with connected(pg_url) as conn:
        namespace = await conn.scalar(
            text("SELECT DISTINCT namespace FROM agent_runtime.materials WHERE namespace LIKE :ns"),
            {"ns": f"%/{mine}"},
        )
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.materials (namespace, url, kind) "
                "VALUES (:ns, :url, 'image')"
            ),
            {"ns": namespace, "url": corner},
        )
    edit = {
        "target": "value:video01Setting",
        "text": "纽约红砖街区参考 @Image7，街角参考 @Image11。",
        "images": [corner],
    }

    edited = await client.patch(f"{URL}/{mine}/film/text", json={"filmVersion": 1, "edits": [edit]})

    assert edited.status_code == 200, edited.text
    group = edited.json()["film"]["groups"][0]
    assert [(frame["node"], frame["number"]) for frame in group["frames"][6:9]] == [
        ("scene", 7),
        ("素材照片1", 8),
        ("view01", 9),
    ]
    assert group["shots"][0]["parts"][0].startswith("参考@Image9，")
    file = await client.get(f"{URL}/{mine}/workspace/file", params={"path": "film.icml"})
    assert f'<media:Image id="素材照片1" src="{corner}"/>' in file.json()["file"]["content"]


async def test_malformed_page_requests_are_422(client: httpx.AsyncClient, pg_url: str) -> None:
    mine = await film_conversation(client, pg_url)

    both = {"target": "shot:video01Shots:1", "text": "x", "parts": ["x"], "lines": []}
    bad_edit = await client.patch(
        f"{URL}/{mine}/film/text", json={"filmVersion": 1, "edits": [both]}
    )
    bad_url = await client.put(
        f"{URL}/{mine}/film/image",
        json={"node": "shoeFrontPhoto", "url": "ftp://x/y.png", "filmVersion": 1, "runVersion": 1},
    )
    inserted = {"target": "value:video01Setting", "text": "x", "images": ["ftp://x/y.png"]}
    bad_insert = await client.patch(
        f"{URL}/{mine}/film/text", json={"filmVersion": 1, "edits": [inserted]}
    )

    assert (bad_edit.status_code, bad_url.status_code, bad_insert.status_code) == (422, 422, 422)


async def test_generation_on_the_page_is_owner_only_and_needs_media_generation(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    mine = await film_conversation(client, pg_url)
    image = {"node": "scene", "filmVersion": 1, "runVersion": 1}
    video = {
        "video": "video01",
        "model": "mmt-seedance-2-5",
        "resolution": "720p",
        "generateAudio": True,
        "filmVersion": 1,
        "runVersion": 1,
    }

    for path, body in (("image-generations", image), ("video-generations", video)):
        refused = await client.post(f"{URL}/{mine}/film/{path}", json=body)
        assert (refused.status_code, refused.json()) == (
            422,
            {"detail": "这里还没开生成，暂时不能生成"},
        )

    async with make_client(app) as governor:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        assert (
            await governor.post(f"{URL}/{mine}/film/image-generations", json=image)
        ).status_code == 403

    too_many = {
        **image,
        "prompt": {"text": "x", "referenceImageUrls": ["https://a.test/1.png"] * 11},
    }
    assert (
        await client.post(f"{URL}/{mine}/film/image-generations", json=too_many)
    ).status_code == 422
