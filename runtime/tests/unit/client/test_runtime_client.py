"""客户端库的 HTTP 失败边界：领域错误恢复、应用拒绝、异常答复、禁止重试、路径隔离与连接所有权。

管理接口另核原样透传与上传下载；带类型方法的正常调用经真实运行时服务和后端集成测试覆盖。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from agent_runtime.app_wire import (
    FileWriteIn,
)
from agent_runtime.client import AppRejected, RuntimeClient, RuntimeUnavailable
from agent_runtime.errors import (
    AgentUnavailable,
    Conflict,
    DomainError,
    NotFound,
    ValidationFailed,
)

BASE = "http://runtime.test"
KEY = "app-key-0123456789-0123456789-abcdef"
SESSION = uuid.UUID("0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d")
OWNER = uuid.UUID("6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10")
S = str(SESSION)


class Recorder:
    """接住请求，按 ``reply`` 答复。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.reply: Callable[[httpx.Request], httpx.Response] = lambda _r: httpx.Response(204)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.reply(request)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


@pytest.fixture
def recorder() -> Recorder:
    return Recorder()


@pytest.fixture
async def client(recorder: Recorder) -> Any:
    async with RuntimeClient(
        f"{BASE}/", KEY, transport=httpx.MockTransport(recorder)
    ) as runtime_client:
        yield runtime_client


async def test_dot_segments_in_a_file_path_stay_inside_the_files_route(
    client: RuntimeClient, recorder: Recorder
) -> None:
    recorder.reply = lambda _r: httpx.Response(422, json={"detail": "路径不合规"})

    with pytest.raises(ValidationFailed):
        await client.read_file(SESSION, "../../agents", owner=OWNER)

    assert recorder.last.url.raw_path.decode() == f"/v1/sessions/{S}/files/%2E%2E/%2E%2E/agents"


@pytest.mark.parametrize(
    ("status", "envelope", "error_type", "code"),
    [
        (404, {"detail": "这段对话里没有这个文件"}, NotFound, None),
        (409, {"detail": "只能重新生成最后一轮"}, Conflict, None),
        (
            409,
            {"detail": "装不起来", "code": "agent_unavailable"},
            AgentUnavailable,
            "agent_unavailable",
        ),
        (422, {"detail": "不是合法的轮 id：1"}, ValidationFailed, None),
        (
            422,
            {"detail": "镜头越界", "code": "shots_out_of_range"},
            ValidationFailed,
            "shots_out_of_range",
        ),
    ],
)
async def test_error_envelopes_come_back_as_the_same_domain_error(
    client: RuntimeClient,
    recorder: Recorder,
    status: int,
    envelope: dict[str, str],
    error_type: type[DomainError],
    code: str | None,
) -> None:
    recorder.reply = lambda _r: httpx.Response(status, json=envelope)

    with pytest.raises(DomainError) as raised:
        await client.run_status(SESSION)

    assert type(raised.value) is error_type
    assert str(raised.value) == envelope["detail"]
    assert raised.value.code == code


APP_REFUSALS = [
    (401, {"detail": "应用密钥无效"}, "应用密钥无效"),
    (403, {"detail": "这个应用没有管理权限"}, "这个应用没有管理权限"),
    (401, "<html>401 Authorization Required</html>", ""),
]
APP_REFUSAL_IDS = ["401", "403", "401-not-an-envelope"]


def _refusal(status: int, body: dict[str, str] | str) -> Callable[[httpx.Request], httpx.Response]:
    if isinstance(body, str):
        return lambda _r: httpx.Response(status, text=body)
    return lambda _r: httpx.Response(status, json=body)


@pytest.mark.parametrize(("status", "body", "detail"), APP_REFUSALS, ids=APP_REFUSAL_IDS)
async def test_app_refusals_are_runtime_unavailable_not_domain_errors(
    client: RuntimeClient,
    recorder: Recorder,
    status: int,
    body: dict[str, str] | str,
    detail: str,
) -> None:
    recorder.reply = _refusal(status, body)

    with pytest.raises(AppRejected) as raised:
        await client.run_status(SESSION)

    assert isinstance(raised.value, RuntimeUnavailable)
    assert not isinstance(raised.value, DomainError)
    assert (raised.value.status, raised.value.detail) == (status, detail)
    assert KEY not in str(raised.value)
    assert KEY not in repr(raised.value)


def _refuse(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("All connection attempts failed")


def _time_out(_request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out")


def _answer(status: int, **kwargs: Any) -> Callable[[httpx.Request], httpx.Response]:
    def reply(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, **kwargs)

    return reply


@pytest.mark.parametrize(
    ("reply", "status"),
    [
        (_refuse, None),
        (_time_out, None),
        (_answer(503, text="upstream down"), 503),
        (_answer(500, json={"detail": "Internal Server Error"}), 500),
        (_answer(405, json={"detail": "Method Not Allowed"}), 405),
        (_answer(404, text="<html>not found</html>"), 404),
        (_answer(200, text="not json"), 200),
        (_answer(200, json={"status": "dancing"}), 200),
    ],
    ids=[
        "connect-error",
        "timeout",
        "503",
        "500-with-envelope",
        "unmapped-4xx",
        "garbage-error-body",
        "garbage-2xx-body",
        "2xx-wrong-shape",
    ],
)
async def test_anything_but_a_domain_error_is_runtime_unavailable(
    client: RuntimeClient,
    recorder: Recorder,
    reply: Callable[[httpx.Request], httpx.Response],
    status: int | None,
) -> None:
    recorder.reply = reply

    with pytest.raises(RuntimeUnavailable) as raised:
        await client.run_status(SESSION)

    assert not isinstance(raised.value, DomainError)
    assert raised.value.status == status
    assert KEY not in str(raised.value)


async def test_nothing_is_retried(client: RuntimeClient, recorder: Recorder) -> None:
    recorder.reply = lambda _r: httpx.Response(503)

    with pytest.raises(RuntimeUnavailable):
        await client.write_file(SESSION, "notes.md", FileWriteIn(content="x"), owner=OWNER)

    assert len(recorder.requests) == 1


async def test_an_injected_http_client_is_used_and_left_open(recorder: Recorder) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(recorder), headers={"X-Trace": "t1"}
    ) as http:
        async with RuntimeClient(BASE, KEY, http=http) as runtime_client:
            recorder.reply = lambda _r: httpx.Response(200, json={"status": "idle"})
            await runtime_client.run_status(SESSION)

        assert recorder.last.headers["x-trace"] == "t1"
        assert not http.is_closed
        # 请求头逐个请求带，不改交进来的客户端。
        assert "authorization" not in http.headers


def test_an_injected_http_client_and_a_transport_are_exclusive() -> None:
    with pytest.raises(ValueError, match="transport"):
        RuntimeClient(
            BASE,
            KEY,
            http=httpx.AsyncClient(),
            transport=httpx.MockTransport(lambda _r: httpx.Response(204)),
        )


# --- 管理接口透传 --------------------------------------------------------------


async def test_admin_errors_pass_through_untouched(
    client: RuntimeClient, recorder: Recorder
) -> None:
    refusal = '{"detail":"版本对不上"}'.encode()
    recorder.reply = lambda _r: httpx.Response(
        409, content=refusal, headers={"content-type": "application/json"}
    )

    answer = await client.admin_request(
        "PUT",
        "agents/director/draft",
        end_user=OWNER,
        json={"lockVersion": 1},
        headers={"Authorization": "Bearer forged", "Accept-Language": "zh"},
    )

    assert (answer.status_code, answer.content) == (409, refusal)
    assert answer.content_type == "application/json"
    request = recorder.last
    assert (request.method, request.url.path) == ("PUT", "/v1/admin/agents/director/draft")
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers["x-end-user"] == str(OWNER)
    assert request.headers["accept-language"] == "zh"
    assert json.loads(request.content) == {"lockVersion": 1}


@pytest.mark.parametrize(("status", "body", "detail"), APP_REFUSALS, ids=APP_REFUSAL_IDS)
async def test_admin_app_refusals_are_raised_not_passed_through(
    client: RuntimeClient,
    recorder: Recorder,
    status: int,
    body: dict[str, str] | str,
    detail: str,
) -> None:
    recorder.reply = _refusal(status, body)

    with pytest.raises(AppRejected) as raised:
        await client.admin_request("POST", "skills", end_user=OWNER, json={})

    assert (raised.value.status, raised.value.detail) == (status, detail)
    assert KEY not in str(raised.value)
    assert KEY not in repr(raised.value)


async def test_admin_downloads_come_back_as_raw_bytes(
    client: RuntimeClient, recorder: Recorder
) -> None:
    archive = b"PK\x03\x04\x00\xffbinary"
    recorder.reply = lambda _r: httpx.Response(
        200,
        content=archive,
        headers={
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="skill.zip"',
        },
    )

    answer = await client.admin_request(
        "GET", "/skills/s1/export", params={"version": "2"}, headers={"X-End-User": "forged"}
    )

    assert answer.content == archive
    assert answer.content_type == "application/zip"
    assert answer.content_disposition == 'attachment; filename="skill.zip"'
    assert recorder.last.url.path == "/v1/admin/skills/s1/export"
    assert dict(recorder.last.url.params) == {"version": "2"}
    assert "x-end-user" not in recorder.last.headers


async def test_admin_uploads_go_out_as_multipart(client: RuntimeClient, recorder: Recorder) -> None:
    recorder.reply = lambda _r: httpx.Response(201, json={"id": "s1"})

    answer = await client.admin_request(
        "POST",
        "skills:import",
        end_user=OWNER,
        files={"file": ("skill.zip", b"PK\x03\x04", "application/zip")},
    )

    assert answer.status_code == 201
    assert recorder.last.headers["content-type"].startswith("multipart/form-data; boundary=")
    assert b'filename="skill.zip"' in recorder.last.content


@pytest.mark.parametrize(
    "reply",
    [_answer(502), _refuse],
    ids=["5xx", "connect-error"],
)
async def test_admin_5xx_and_transport_errors_are_runtime_unavailable(
    client: RuntimeClient, recorder: Recorder, reply: Callable[[httpx.Request], httpx.Response]
) -> None:
    recorder.reply = reply

    with pytest.raises(RuntimeUnavailable):
        await client.admin_request("GET", "skills")


@pytest.mark.parametrize("path", ["../sessions", "skills/../../sessions", "skills?x=1", "a#b"])
async def test_admin_paths_cannot_leave_the_admin_prefix(
    client: RuntimeClient, recorder: Recorder, path: str
) -> None:
    with pytest.raises(ValueError, match="路径"):
        await client.admin_request("GET", path)

    assert recorder.requests == []


async def test_admin_takes_one_kind_of_body(client: RuntimeClient) -> None:
    with pytest.raises(ValueError, match="至多"):
        await client.admin_request("POST", "skills", json={}, content=b"x")
