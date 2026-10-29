"""验证做同款：建对话时带 ``sameAs``，源按资料库认；拷哪几份文件、改什么名、拷台账，什么时候
不拷、不落行。"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_GENERATE, request_to_payload
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.generation import video_request
from tests.helpers.pg import connected

URL = "/conversations"
AGENT_ID = "director"
MATERIALS = ("https://cdn.test/chosen.png", "https://cdn.test/ref.mp4")


async def open_conversation(client: httpx.AsyncClient) -> str:
    opened = await client.post(URL, json={"agentId": AGENT_ID})
    assert opened.status_code == 201, opened.text
    return opened.json()["conversation"]["id"]


async def plant_master(pg_url: str, owner: str, conversation_id: str | None) -> str:
    """一条成了的出片；挂着对话就让那段对话进资料库，不挂对话时它自己成一张卡。返回出片 id。"""

    job_id = str(uuid.uuid4())
    async with connected(pg_url) as conn:
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
                "id": job_id,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": KIND_VIDEO,
                "operation": OPERATION_GENERATE,
                "request": json.dumps(request_to_payload(video_request())),
                "status": STATUS_COMPLETED,
            },
        )
    return job_id


async def open_source(client: httpx.AsyncClient, pg_url: str, owner: str) -> str:
    """开一段有素材片的对话，资料库里有它的卡，卡 id 就是对话 id。"""

    source = await open_conversation(client)
    await plant_master(pg_url, owner, source)
    return source


async def make_same(
    client: httpx.AsyncClient, source: str, *, conversation_id: str | None = None
) -> httpx.Response:
    body: dict[str, object] = {"agentId": AGENT_ID, "sameAs": source}
    if conversation_id is not None:
        body["id"] = conversation_id
    return await client.post(URL, json=body)


async def plant(pg_url: str, namespace: str, files: dict[str, str]) -> None:
    """往工作区放文件，往台账登记 ``MATERIALS``。"""

    async with connected(pg_url) as conn:
        for path, content in files.items():
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.workspace_files"
                    " (namespace, path, content, version, created_at, updated_at)"
                    " VALUES (:ns, :path, :content, 4, now(), now())"
                ),
                {"ns": namespace, "path": path, "content": content},
            )
        for url in MATERIALS:
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.materials (namespace, url, kind)"
                    " VALUES (:ns, :url, :kind)"
                ),
                {"ns": namespace, "url": url, "kind": "video" if url.endswith("mp4") else "image"},
            )


async def files_of(pg_url: str, namespace: str) -> dict[str, str]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT path, content FROM agent_runtime.workspace_files"
                " WHERE namespace = :ns ORDER BY path"
            ),
            {"ns": namespace},
        )
        return {row.path: row.content for row in rows}


async def materials_of(pg_url: str, namespace: str) -> set[tuple[str, str]]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text("SELECT url, kind FROM agent_runtime.materials WHERE namespace = :ns"),
            {"ns": namespace},
        )
        return {(row.url, row.kind) for row in rows}


async def row_exists(pg_url: str, conversation_id: str) -> bool:
    async with connected(pg_url) as conn:
        found = await conn.execute(
            text("SELECT 1 FROM iclip.conversations WHERE id = :id"), {"id": conversation_id}
        )
        return found.first() is not None


async def assert_nothing_left(pg_url: str, owner: str, target: str) -> None:
    assert not await row_exists(pg_url, target)
    assert await files_of(pg_url, f"{owner}/{target}") == {}
    assert await materials_of(pg_url, f"{owner}/{target}") == set()


EVERYTHING = {
    "treatment.md": "# 方案",
    "film.icml": "<film/>",
    "film.icrun": "<run/>",
    "video_shot.json": '{"shots": []}',
    "brief.md": "# 需求",
    "references/a.md": "参考",
    "frames/1.md": "帧",
}

LEDGER = {("https://cdn.test/chosen.png", "image"), ("https://cdn.test/ref.mp4", "video")}


async def test_same_as_copies_the_four_files_renamed_and_the_whole_ledger(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", EVERYTHING)

    made = await make_same(client, source)

    assert made.status_code == 201, made.text
    copy = made.json()["conversation"]
    assert (copy["forkedFrom"], copy["forkTurn"], copy["ownerUserId"]) == (None, None, owner)
    assert await files_of(pg_url, f"{owner}/{copy['id']}") == {
        "treatment.md": "# 方案",
        "old_film.icml": "<film/>",
        "film.icrun": "<run/>",
        "old_video_shot.json": '{"shots": []}',
    }
    assert await materials_of(pg_url, f"{owner}/{copy['id']}") == LEDGER
    transcript = await client.get(f"{URL}/{copy['id']}/transcript")
    assert transcript.status_code == 200, transcript.text
    assert transcript.json()["items"] == [], "不拷历史"
    assert await files_of(pg_url, f"{owner}/{source}") == EVERYTHING, "源不能被动到"


@pytest.mark.parametrize(
    ("present", "copied"),
    [
        ({"video_shot.json": "{}", "brief.md": "x"}, {"old_video_shot.json": "{}"}),
        (
            {"film.icml": "<film/>", "treatment.md": "t"},
            {"old_film.icml": "<film/>", "treatment.md": "t"},
        ),
    ],
)
async def test_files_the_source_does_not_have_are_skipped(
    client: httpx.AsyncClient, pg_url: str, present: dict[str, str], copied: dict[str, str]
) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", present)

    made = await make_same(client, source)

    assert made.status_code == 201, made.text
    assert await files_of(pg_url, f"{owner}/{made.json()['conversation']['id']}") == copied


async def test_a_running_source_is_copied_anyway(client: httpx.AsyncClient, pg_url: str) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", {"film.icml": "<film/>"})
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.agent_jobs"
                " (prompt_id, conversation_id, agent_id, owner_user_id, user_name,"
                "  content, status, created_at)"
                " VALUES (:pid, :cid, :agent, :owner, 'logan', '[]', 'queued', now())"
            ),
            {
                "pid": f"prm_{uuid.uuid4().hex[:16]}",
                "cid": source,
                "agent": AGENT_ID,
                "owner": owner,
            },
        )

    assert (await make_same(client, source)).status_code == 201


async def test_a_colleagues_library_card_is_copied_into_the_callers_own_conversation(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", {"film.icml": "<film/>", "treatment.md": "t"})

    async with make_client(app) as colleague:
        other = await login_as_editor(colleague, pg_url, username="mallory")
        made = await make_same(colleague, source)
        opened = await colleague.get(f"{URL}/{source}")

    assert made.status_code == 201, made.text
    copy = made.json()["conversation"]
    assert copy["ownerUserId"] == other
    assert await files_of(pg_url, f"{other}/{copy['id']}") == {
        "old_film.icml": "<film/>",
        "treatment.md": "t",
    }
    assert await materials_of(pg_url, f"{other}/{copy['id']}") == LEDGER
    assert opened.status_code == 404, "做得了同款也仍打不开别人的对话"


async def test_a_deleted_source_with_a_library_card_is_copied_anyway(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", {"film.icml": "<film/>"})
    deleted = await client.delete(f"{URL}/{source}")
    assert deleted.status_code == 204, deleted.text

    made = await make_same(client, source)

    assert made.status_code == 201, made.text
    copy = made.json()["conversation"]
    assert await files_of(pg_url, f"{owner}/{copy['id']}") == {"old_film.icml": "<film/>"}
    assert await materials_of(pg_url, f"{owner}/{copy['id']}") == LEDGER


async def test_a_source_that_is_not_a_library_card_with_a_conversation_is_404_and_leaves_nothing(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """没有素材片的对话不在资料库里，自己的也不行；不挂对话的卡没有对话可拷。"""

    owner = await login_as_editor(client, pg_url)
    theirs = await open_conversation(client)
    await plant(pg_url, f"{owner}/{theirs}", {"film.icml": "<film/>"})

    async with make_client(app) as caller:
        me = await login_as_editor(caller, pg_url, username="mallory")
        own = await open_conversation(caller)
        await plant(pg_url, f"{me}/{own}", {"film.icml": "<film/>"})
        orphan = await plant_master(pg_url, me, None)
        for source in (own, theirs, orphan, str(uuid.uuid4())):
            target = str(uuid.uuid4())
            refused = await make_same(caller, source, conversation_id=target)
            assert refused.status_code == 404, refused.text
            await assert_nothing_left(pg_url, me, target)


async def test_a_caller_without_generation_read_is_404_and_leaves_nothing_behind(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """只授 ``agent:run`` 的钥匙看不到资料库，连钥匙属主自己的卡也做不了同款。"""

    owner = await register_and_login(client, username="gov", email="gov@example.com")
    await set_roles_in_db(pg_url, "gov@example.com", ["root"])
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", {"film.icml": "<film/>"})
    issued = await client.post(
        "/api-keys", json={"name": "partner-app", "permissions": ["agent:run"]}
    )
    assert issued.status_code == 201, issued.text
    target = str(uuid.uuid4())

    async with make_client(app) as machine:
        machine.headers["Authorization"] = f"Bearer {issued.json()['apiKey']['token']}"
        refused = await make_same(machine, source, conversation_id=target)

    assert refused.status_code == 404, refused.text
    await assert_nothing_left(pg_url, owner, target)
    assert (await make_same(client, source)).status_code == 201, "同一个人在浏览器里看得到资料库"


async def test_a_source_without_a_film_or_shot_file_is_422_and_leaves_nothing_behind(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", {"treatment.md": "t", "film.icrun": "<run/>"})
    target = str(uuid.uuid4())

    refused = await make_same(client, source, conversation_id=target)

    assert refused.status_code == 422, refused.text
    await assert_nothing_left(pg_url, owner, target)


async def test_a_retry_with_the_same_id_does_not_copy_again(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = await login_as_editor(client, pg_url)
    source = await open_source(client, pg_url, owner)
    await plant(pg_url, f"{owner}/{source}", {"film.icml": "<film/>"})
    target = str(uuid.uuid4())
    assert (await make_same(client, source, conversation_id=target)).status_code == 201
    edited = await client.put(
        f"{URL}/{target}/workspace/file",
        json={"path": "old_film.icml", "content": "<film edited/>", "expectedVersion": 1},
    )
    assert edited.status_code == 200, edited.text
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.materials (namespace, url, kind)"
                " VALUES (:ns, 'https://cdn.test/later.png', 'image')"
            ),
            {"ns": f"{owner}/{source}"},
        )

    retried = await make_same(client, source, conversation_id=target)

    assert retried.status_code == 200, retried.text
    assert retried.json()["conversation"]["id"] == target
    assert await files_of(pg_url, f"{owner}/{target}") == {"old_film.icml": "<film edited/>"}
    assert ("https://cdn.test/later.png", "image") not in await materials_of(
        pg_url, f"{owner}/{target}"
    )
