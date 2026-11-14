from __future__ import annotations

import os
import secrets
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from agent_runtime.harness.step_store_pg import PgStepStore
from fastapi import FastAPI
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, RunRecord, StepEvent
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from iclip.domains.conversations.whole_film_project import PreviewGrant, PreviewTokens
from iclip.platform.db.engine import build_engine
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.ws import sign_in_as

URL = "/conversations"
AGENT_ID = "storyboard"
APP_ORIGIN = "http://localhost:3013"
PREVIEW_ORIGIN = "http://preview.test"
SESSION_COOKIE = "iclip_session"


def server_tokens() -> PreviewTokens:
    """与被测服务同一把 ``AUTH_SECRET`` 派生出来的令牌编解码，用来铸过期或别的令牌。"""

    return PreviewTokens(os.environ["AUTH_SECRET"])


@pytest.fixture
def preview_origin() -> str | None:
    return PREVIEW_ORIGIN


@pytest.fixture(autouse=True)
def _preview_env(
    monkeypatch: pytest.MonkeyPatch, base_env: None, preview_origin: str | None
) -> None:
    if preview_origin is None:
        monkeypatch.delenv("WHOLE_FILM_PREVIEW_ORIGIN", raising=False)
    else:
        monkeypatch.setenv("WHOLE_FILM_PREVIEW_ORIGIN", preview_origin)


@pytest.fixture
async def preview(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=PREVIEW_ORIGIN
    ) as client:
        yield client


async def open_conversation(client: httpx.AsyncClient) -> str:
    opened = await client.post(URL, json={"agentId": AGENT_ID})
    assert opened.status_code == 201, opened.text
    return str(opened.json()["conversation"]["id"])


async def open_preview(
    client: httpx.AsyncClient, conversation_id: str, *, origin: str | None = APP_ORIGIN
) -> httpx.Response:
    return await client.post(
        f"{URL}/{conversation_id}/whole-film/preview",
        headers={} if origin is None else {"origin": origin},
    )


async def token_for(client: httpx.AsyncClient, conversation_id: str) -> str:
    opened = await open_preview(client, conversation_id)
    assert opened.status_code == 200, opened.text
    return str(opened.json()["token"])


async def create_file(
    client: httpx.AsyncClient, conversation_id: str, path: str, content: str
) -> httpx.Response:
    return await client.post(
        f"{URL}/{conversation_id}/whole-film/files", json={"path": path, "content": content}
    )


def file_url(token: str, path: str) -> str:
    return f"/whole-film/preview/{token}/files/{path}"


async def login_as_governor(client: httpx.AsyncClient, pg_url: str) -> str:
    user_id = await register_and_login(client, username="gov", email="gov@example.com")
    await set_roles_in_db(pg_url, "gov@example.com", ["root"])
    return user_id


async def test_preview_host_serves_only_preview_addresses(
    client: httpx.AsyncClient, preview: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    assert (await create_file(client, mine, "index.html", "<p>片</p>")).status_code == 201
    token = await token_for(client, mine)
    session = {"cookie": f"{SESSION_COOKIE}={client.cookies.get(SESSION_COOKIE)}"}

    assert (await client.get("/users/me")).status_code == 200, "应用域名上照常"
    for method, path in (
        ("POST", "/auth/login"),
        ("GET", "/users/me"),
        ("GET", URL),
        ("GET", f"{URL}/{mine}/workspace/files"),
        ("POST", f"{URL}/{mine}/whole-film/preview"),
        ("GET", "/healthz"),
        ("GET", "/openapi.json"),
    ):
        refused = await preview.request(method, path, headers=session)
        assert refused.status_code == 404, f"预览域名上 {method} {path} 必须 404"

    assert (await preview.get(file_url(token, "index.html"))).status_code == 200
    assert (await preview.get(f"/whole-film/preview/{token}/host")).status_code == 200
    assert (await client.get(file_url(token, "index.html"))).status_code == 404
    assert (await client.get(f"/whole-film/preview/{token}/host")).status_code == 404


def test_preview_host_refuses_websocket_upgrades(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        session = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        with tc.websocket_connect("/ws", headers=session) as ws:
            assert ws.receive_json()["type"] == "server_hello", "应用域名上同一个登录态连得上"

        with (
            pytest.raises(WebSocketDisconnect),
            tc.websocket_connect(
                "/ws", headers={**session, "host": "preview.test", "origin": PREVIEW_ORIGIN}
            ),
        ):
            pass


async def test_token_goes_to_readers_and_carries_the_request_origin(
    app: FastAPI, client: httpx.AsyncClient, preview: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    assert (await create_file(client, mine, "index.html", "属主的片")).status_code == 201

    before = datetime.now(UTC)
    opened = await open_preview(client, mine)
    assert opened.status_code == 200, opened.text
    ticket = opened.json()
    assert ticket["origin"] == PREVIEW_ORIGIN
    expires_at = datetime.fromisoformat(ticket["expiresAt"])
    assert timedelta(minutes=59) < expires_at - before <= timedelta(hours=1)
    host = await preview.get(f"/whole-film/preview/{ticket['token']}/host")
    assert host.status_code == 200, host.text
    assert host.json() == {"appOrigin": APP_ORIGIN}

    for origin in (None, "null", "http://localhost:3013/path"):
        refused = await open_preview(client, mine, origin=origin)
        assert refused.status_code == 422, f"Origin {origin!r} 不能签发"

    async with make_client(app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        assert (await open_preview(stranger, mine)).status_code == 404

    async with make_client(app) as governor:
        await login_as_governor(governor, pg_url)
        governor_token = await token_for(governor, mine)
    read = await preview.get(file_url(governor_token, "index.html"))
    assert (read.status_code, read.text) == (200, "属主的片"), "治理者的令牌取的是属主的工程"


@pytest.mark.parametrize("preview_origin", [None], ids=["unconfigured"])
async def test_without_a_preview_origin_no_token_is_issued_and_no_host_serves_previews(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await open_conversation(client)

    refused = await open_preview(client, mine)
    assert refused.status_code == 422, refused.text
    assert "预览域名" in refused.json()["detail"]

    minted = server_tokens().issue(
        PreviewGrant(
            owner_user_id=owner,
            conversation_id=uuid.UUID(mine),
            app_origin=APP_ORIGIN,
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )
    )
    assert (await client.get(f"/whole-film/preview/{minted}/host")).status_code == 404


async def test_expired_tampered_and_swapped_tokens_are_refused(
    client: httpx.AsyncClient, preview: httpx.AsyncClient, pg_url: str
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    first = await open_conversation(client)
    second = await open_conversation(client)
    assert (await create_file(client, first, "index.html", "第一段")).status_code == 201
    assert (await create_file(client, second, "other.html", "第二段")).status_code == 201
    first_token = await token_for(client, first)
    second_token = await token_for(client, second)

    def minted(expires_at: datetime) -> str:
        return server_tokens().issue(
            PreviewGrant(
                owner_user_id=owner,
                conversation_id=uuid.UUID(first),
                app_origin=APP_ORIGIN,
                expires_at=expires_at,
            )
        )

    now = datetime.now(UTC)
    fresh = await preview.get(file_url(minted(now + timedelta(minutes=5)), "index.html"))
    assert fresh.status_code == 200, "同一种令牌没过期时取得到，下面的 403 只因为过期"

    first_body, _, first_signature = first_token.partition(".")
    second_body, _, _ = second_token.partition(".")
    flipped = first_signature[:-1] + ("A" if first_signature[-1] != "A" else "B")
    for bad in (
        minted(now - timedelta(seconds=1)),
        f"{second_body}.{first_signature}",
        f"{first_body}.{flipped}",
        PreviewTokens(secrets.token_urlsafe(32)).issue(
            PreviewGrant(
                owner_user_id=owner,
                conversation_id=uuid.UUID(first),
                app_origin=APP_ORIGIN,
                expires_at=now + timedelta(minutes=5),
            )
        ),
        "not-a-token",
    ):
        assert (await preview.get(file_url(bad, "index.html"))).status_code == 403
        assert (await preview.get(f"/whole-film/preview/{bad}/host")).status_code == 403

    assert (await preview.get(file_url(second_token, "index.html"))).status_code == 404, (
        "第二段的令牌取不到只在第一段里的文件"
    )
    assert (await preview.get(file_url(second_token, "other.html"))).text == "第二段"


@pytest.mark.parametrize(
    ("path", "content_type"),
    [
        ("index.html", "text/html; charset=utf-8"),
        ("compositions/components/标题.html", "text/html; charset=utf-8"),
        ("assets/style.css", "text/css; charset=utf-8"),
        ("assets/main.js", "text/javascript; charset=utf-8"),
        ("assets/main.mjs", "text/javascript; charset=utf-8"),
        ("assets/data.json", "application/json"),
        ("assets/logo.svg", "image/svg+xml"),
        ("assets/notes.txt", "text/plain; charset=utf-8"),
        ("assets/beats.bin", "application/octet-stream"),
        ("assets/README", "application/octet-stream"),
    ],
)
async def test_project_files_are_served_as_is_with_their_type(
    client: httpx.AsyncClient,
    preview: httpx.AsyncClient,
    pg_url: str,
    path: str,
    content_type: str,
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    content = f"<!-- {path} -->\n内容"
    assert (await create_file(client, mine, path, content)).status_code == 201
    token = await token_for(client, mine)

    served = await preview.get(file_url(token, path))

    assert served.status_code == 200, served.text
    assert served.content == content.encode()
    assert served.headers["content-type"] == content_type
    assert served.headers["cache-control"] == "no-store"
    assert served.headers["x-content-type-options"] == "nosniff"
    assert served.headers["referrer-policy"] == "no-referrer"


async def test_missing_and_irregular_paths_are_404_and_vendor_redirects(
    client: httpx.AsyncClient, preview: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    assert (await create_file(client, mine, "index.html", "片")).status_code == 201
    assert (await create_file(client, mine, "assets/a.txt", "a")).status_code == 201
    token = await token_for(client, mine)
    base = f"/whole-film/preview/{token}/files"

    assert (await preview.get(f"{base}/index.html")).status_code == 200
    for raw in (
        "missing.html",
        "assets/%2E%2E/index.html",
        "%2e%2e/%2e%2e/secret.txt",
        "/index.html",
        "assets//a.txt",
        "assets%5Ca.txt",
        "%2E/index.html",
        "assets/",
        "vendor/",
    ):
        missing = await preview.get(f"{base}/{raw}")
        assert missing.status_code == 404, f"{raw} 应当 404，实得 {missing.status_code}"
        assert missing.json()["detail"] == "成片工程里没有这个文件", f"{raw} 要到达取文件的路由"

    redirected = await preview.get(f"{base}/vendor/runtime/player.js")
    assert redirected.status_code == 307
    assert redirected.headers["location"] == "/hyperframes/vendor/runtime/player.js"
    quoted = await preview.get(f"{base}/vendor/字体/思源 黑体.woff2")
    assert quoted.status_code == 307
    assert quoted.headers["location"] == (
        "/hyperframes/vendor/%E5%AD%97%E4%BD%93/%E6%80%9D%E6%BA%90%20%E9%BB%91%E4%BD%93.woff2"
    )


async def seed_turn(pg_url: str, conversation_id: str) -> None:
    engine = build_engine(pg_url)
    try:
        store = PgStepStore(engine)
        run_id = f"{AGENT_ID}-{uuid.uuid4().hex[:8]}"
        at = datetime(2026, 9, 1, tzinfo=UTC)
        await store.register_run(RunRecord(run_id=run_id, conversation_id=conversation_id))
        await store.append_event(
            StepEvent(
                run_id=run_id, conversation_id=conversation_id, kind="run_completed", step_index=1
            )
        )
        await store.save_snapshot(
            ContinuableSnapshot(
                run_id=run_id,
                conversation_id=conversation_id,
                step_index=1,
                messages=[
                    ModelRequest(parts=[UserPromptPart("开拍", timestamp=at)], run_id=run_id),
                    ModelResponse(parts=[TextPart("好的")], timestamp=at, run_id=run_id),
                ],
            )
        )
    finally:
        await engine.dispose()


async def test_a_fork_by_another_user_previews_its_own_files(
    app: FastAPI, client: httpx.AsyncClient, preview: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    source = await open_conversation(client)
    assert (await create_file(client, source, "index.html", "原片")).status_code == 201
    await seed_turn(pg_url, source)

    async with make_client(app) as governor:
        await login_as_governor(governor, pg_url)
        forked = await governor.post(f"{URL}/{source}:fork", json={"turn": 1})
        assert forked.status_code == 201, forked.text
        copy = forked.json()["conversation"]["id"]
        rewritten = await governor.put(
            f"{URL}/{copy}/workspace/file",
            json={"path": "whole-film/index.html", "content": "改过的片", "expectedVersion": 1},
        )
        assert rewritten.status_code == 200, rewritten.text
        copy_token = await token_for(governor, copy)

    source_token = await token_for(client, source)
    assert (await preview.get(file_url(source_token, "index.html"))).text == "原片"
    assert (await preview.get(file_url(copy_token, "index.html"))).text == "改过的片"


async def test_owner_creates_project_files_once_and_edits_them_with_the_workspace_put(
    app: FastAPI, client: httpx.AsyncClient, preview: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)

    created = await create_file(client, mine, "compositions/components/x.html", "<p>初稿</p>")
    assert created.status_code == 201, created.text
    assert created.json() == {"path": "compositions/components/x.html", "version": 1}

    again = await create_file(client, mine, "compositions/components/x.html", "<p>覆盖</p>")
    assert again.status_code == 409, again.text

    for bad in ("../x.html", "/x.html", "a\\x.html", "a//x.html", "a/./x.html", "a/"):
        refused = await create_file(client, mine, bad, "x")
        assert refused.status_code == 422, f"{bad!r} 应当 422，实得 {refused.status_code}"
    assert (await create_file(client, mine, "", "x")).status_code == 422

    workspace_path = "whole-film/compositions/components/x.html"
    read = await client.get(f"{URL}/{mine}/workspace/file", params={"path": workspace_path})
    assert read.json()["file"] == {"path": workspace_path, "content": "<p>初稿</p>", "version": 1}
    edited = await client.put(
        f"{URL}/{mine}/workspace/file",
        json={"path": workspace_path, "content": "<p>二稿</p>", "expectedVersion": 1},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["file"]["version"] == 2
    token = await token_for(client, mine)
    served = await preview.get(file_url(token, "compositions/components/x.html"))
    assert served.text == "<p>二稿</p>"

    files = (await client.get(f"{URL}/{mine}/workspace/files")).json()["files"]
    assert [item["path"] for item in files] == [workspace_path], "坏路径一个都没写进去"


async def test_only_the_owner_of_a_live_conversation_creates_project_files(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    doomed = await open_conversation(client)
    assert (await client.delete(f"{URL}/{doomed}")).status_code == 204
    gone = await create_file(client, doomed, "index.html", "x")
    assert gone.status_code == 404, "普通属主看不见自己删掉的对话"

    async with make_client(app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        assert (await create_file(stranger, mine, "index.html", "x")).status_code == 404

    async with make_client(app) as governor:
        await login_as_governor(governor, pg_url)
        assert (await create_file(governor, mine, "index.html", "x")).status_code == 403
        own = await open_conversation(governor)
        assert (await governor.delete(f"{URL}/{own}")).status_code == 204
        deleted = await create_file(governor, own, "index.html", "x")
        assert deleted.status_code == 403, "治理者看得见自己删掉的对话，但不能再写"

    files = (await client.get(f"{URL}/{mine}/workspace/files")).json()["files"]
    assert files == []
