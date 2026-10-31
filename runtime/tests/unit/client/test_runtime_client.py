"""客户端库的 HTTP 一半：每个带类型方法发出的请求（方法、路径、查询、请求头、请求体）与答复解析，报错还原成
领域错误或 ``RuntimeUnavailable``（401、403 是 ``AppRejected``），管理接口除 401、403 外原样透传。经
``httpx.MockTransport`` 接住请求，不连服务。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from agent_runtime.app_wire import (
    ActivitiesIn,
    ActivitiesOut,
    AgentDirectoryOut,
    AgentEntryOut,
    BusyOut,
    FilesCopyIn,
    FilesCopyOut,
    FilesOut,
    FileWriteIn,
    MaterialsIn,
    SessionForkIn,
    SessionOpenIn,
    SessionPromptIn,
    TitleIn,
    TitleOut,
)
from agent_runtime.client import AppRejected, RuntimeClient, RuntimeUnavailable
from agent_runtime.errors import (
    AgentUnavailable,
    Conflict,
    DomainError,
    NotFound,
    ValidationFailed,
)
from agent_runtime.file_store.store import FileEntry, StoredFile
from agent_runtime.material_ledger.store import Material
from agent_runtime.transcript.ops import (
    AttachmentSource,
    ImageContent,
    Prompt,
    TextContent,
)
from agent_runtime.transcript.wire import (
    ApprovalRequest,
    OpsCatchup,
    PromptQueueOut,
    RegenerateBody,
    RunStatusOut,
    SessionActivityOut,
    SteerRequest,
    TranscriptPage,
)

BASE = "http://runtime.test"
KEY = "app-key-0123456789-0123456789-abcdef"
SESSION = uuid.UUID("0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d")
TARGET = uuid.UUID("1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d")
OWNER = uuid.UUID("6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10")
SOURCE_USER = uuid.UUID("7a2e9b5f-3c8d-4f1b-8e62-4d3a8f9c0b21")
S = str(SESSION)

PROMPT = Prompt(prompt_id="prm_1", status="queued", created_at="2026-10-30T00:00:00Z")
ENTRY = FileEntry(
    path="notes.md", size_bytes=6, version=2, updated_at=datetime(2026, 10, 30, tzinfo=UTC)
)
ENTRY_JSON = {
    "path": "notes.md",
    "size_bytes": 6,
    "version": 2,
    "updated_at": "2026-10-30T00:00:00Z",
}
PAGE = TranscriptPage(agent_id="main", items=(), has_more=False, seq=3, stream_epoch="e1")


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


def _dumped(value: Any) -> Any:
    """答复体照运行时的写法：pydantic 模型按别名、带上空字段；数据类按字段名。"""

    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True)
    return value


@dataclass(frozen=True)
class Case:
    call: Callable[[RuntimeClient], Awaitable[Any]]
    method: str
    path: str
    params: dict[str, str]
    owner: bool
    body: Any
    status: int
    reply: Any
    expected: Any


CASES: dict[str, Case] = {
    "open_session": Case(
        lambda c: c.open_session(SessionOpenIn(id=SESSION, agent_id="director")),
        "POST",
        "/v1/sessions",
        {},
        False,
        {"id": S, "agent_id": "director"},
        204,
        None,
        None,
    ),
    "fork_session": Case(
        lambda c: c.fork_session(
            SESSION, SessionForkIn(target_id=TARGET, source_user=SOURCE_USER, turn=2), owner=OWNER
        ),
        "POST",
        f"/v1/sessions/{S}:fork",
        {},
        True,
        {"target_id": str(TARGET), "source_user": str(SOURCE_USER), "turn": 2},
        204,
        None,
        None,
    ),
    "copy_files": Case(
        lambda c: c.copy_files(
            SESSION,
            FilesCopyIn(
                target_id=TARGET,
                source_user=SOURCE_USER,
                files=(("a.md", "b.md"),),
                require_any=("a.md",),
            ),
            owner=OWNER,
        ),
        "POST",
        f"/v1/sessions/{S}/files:copy",
        {},
        True,
        {
            "target_id": str(TARGET),
            "source_user": str(SOURCE_USER),
            "files": [["a.md", "b.md"]],
            "require_any": ["a.md"],
        },
        200,
        {"copied": True},
        FilesCopyOut(copied=True),
    ),
    "activities": Case(
        lambda c: c.activities(ActivitiesIn(ids=(SESSION,))),
        "POST",
        "/v1/sessions:activities",
        {},
        False,
        {"ids": [S]},
        200,
        {"items": {S: {"busy": True, "pending_interaction": "approval", "last_turn_reason": None}}},
        ActivitiesOut(
            items={SESSION: SessionActivityOut(busy=True, pending_interaction="approval")}
        ),
    ),
    "busy_for_one_owner": Case(
        lambda c: c.busy(owner=OWNER),
        "GET",
        "/v1/sessions:busy",
        {"end_user": str(OWNER)},
        False,
        None,
        200,
        {"ids": [S]},
        BusyOut(ids=(SESSION,)),
    ),
    "busy_for_all": Case(
        lambda c: c.busy(),
        "GET",
        "/v1/sessions:busy",
        {},
        False,
        None,
        200,
        {"ids": []},
        BusyOut(ids=()),
    ),
    "prompt_queue": Case(
        lambda c: c.prompt_queue(SESSION),
        "GET",
        f"/v1/sessions/{S}/prompts",
        {},
        False,
        None,
        200,
        {"active": _dumped(PROMPT), "queued": []},
        PromptQueueOut(active=PROMPT, queued=()),
    ),
    "abort_prompt": Case(
        lambda c: c.abort_prompt(SESSION, "prm_1"),
        "POST",
        f"/v1/sessions/{S}/prompts/prm_1:abort",
        {},
        False,
        None,
        204,
        None,
        None,
    ),
    "abort_session": Case(
        lambda c: c.abort_session(SESSION),
        "POST",
        f"/v1/sessions/{S}:abort",
        {},
        False,
        None,
        204,
        None,
        None,
    ),
    "steer": Case(
        lambda c: c.steer(SESSION, SteerRequest(prompt_ids=("prm_2",))),
        "POST",
        f"/v1/sessions/{S}/prompts:steer",
        {},
        False,
        {"prompt_ids": ["prm_2"]},
        204,
        None,
        None,
    ),
    "regenerate_with_body": Case(
        lambda c: c.regenerate(SESSION, "t1", RegenerateBody(prompt_id="prm_again")),
        "POST",
        f"/v1/sessions/{S}/turns/t1:regenerate",
        {},
        False,
        {"prompt_id": "prm_again"},
        200,
        _dumped(PROMPT),
        PROMPT,
    ),
    "regenerate_without_body": Case(
        lambda c: c.regenerate(SESSION, "t1"),
        "POST",
        f"/v1/sessions/{S}/turns/t1:regenerate",
        {},
        False,
        None,
        200,
        _dumped(PROMPT),
        PROMPT,
    ),
    "approve": Case(
        lambda c: c.approve(SESSION, "int_1", ApprovalRequest(approved=False)),
        "POST",
        f"/v1/sessions/{S}/interactions/int_1",
        {},
        False,
        {"approved": False},
        204,
        None,
        None,
    ),
    "run_status": Case(
        lambda c: c.run_status(SESSION),
        "GET",
        f"/v1/sessions/{S}/status",
        {},
        False,
        None,
        200,
        {"status": "completed"},
        RunStatusOut(status="completed"),
    ),
    "transcript_page": Case(
        lambda c: c.transcript_page(
            SESSION, session_agent="director", before_turn="t5", page_size=10
        ),
        "GET",
        f"/v1/sessions/{S}/transcript",
        {"session_agent": "director", "agent": "main", "before_turn": "t5", "page_size": "10"},
        False,
        None,
        200,
        _dumped(PAGE),
        PAGE,
    ),
    "transcript_ops": Case(
        lambda c: c.transcript_ops(SESSION, since_seq=2, agent="run_9", stream_epoch="e1"),
        "GET",
        f"/v1/sessions/{S}/transcript/ops",
        {"since_seq": "2", "agent": "run_9", "stream_epoch": "e1"},
        False,
        None,
        200,
        {
            "agent_id": "run_9",
            "batches": [],
            "latest_seq": 2,
            "complete": True,
            "stream_epoch": "e1",
        },
        OpsCatchup(agent_id="run_9", batches=(), latest_seq=2, complete=True, stream_epoch="e1"),
    ),
    "list_files": Case(
        lambda c: c.list_files(SESSION, owner=OWNER, prefix="docs"),
        "GET",
        f"/v1/sessions/{S}/files",
        {"prefix": "docs"},
        True,
        None,
        200,
        {"files": [ENTRY_JSON]},
        FilesOut(files=(ENTRY,)),
    ),
    "read_file": Case(
        lambda c: c.read_file(SESSION, "制作/方案 1.md", owner=OWNER),
        "GET",
        f"/v1/sessions/{S}/files/%E5%88%B6%E4%BD%9C/%E6%96%B9%E6%A1%88%201.md",
        {},
        True,
        None,
        200,
        {"path": "制作/方案 1.md", "content": "正文", "version": 1},
        StoredFile(path="制作/方案 1.md", content="正文", version=1),
    ),
    "write_file": Case(
        lambda c: c.write_file(
            SESSION, "notes.md", FileWriteIn(content="记一笔", expected_version=1), owner=OWNER
        ),
        "PUT",
        f"/v1/sessions/{S}/files/notes.md",
        {},
        True,
        {"content": "记一笔", "expected_version": 1},
        200,
        ENTRY_JSON,
        ENTRY,
    ),
    "record_materials": Case(
        lambda c: c.record_materials(
            SESSION,
            MaterialsIn(materials=(Material(url="https://cdn.test/a.jpg", kind="image"),)),
            owner=OWNER,
        ),
        "POST",
        f"/v1/sessions/{S}/materials",
        {},
        True,
        {"materials": [{"url": "https://cdn.test/a.jpg", "kind": "image"}]},
        204,
        None,
        None,
    ),
    "lookup_material": Case(
        lambda c: c.lookup_material(SESSION, "https://cdn.test/a.jpg", owner=OWNER),
        "GET",
        f"/v1/sessions/{S}/materials",
        {"url": "https://cdn.test/a.jpg"},
        True,
        None,
        200,
        {"url": "https://cdn.test/a.jpg", "kind": "image"},
        Material(url="https://cdn.test/a.jpg", kind="image"),
    ),
    "agents": Case(
        lambda c: c.agents(),
        "GET",
        "/v1/agents",
        {},
        False,
        None,
        200,
        {"items": [{"id": "director", "name": "AI 导演"}], "default": "director"},
        AgentDirectoryOut(
            items=(AgentEntryOut(id="director", name="AI 导演"),), default="director"
        ),
    ),
    "generate_title": Case(
        lambda c: c.generate_title(TitleIn(text="拍一条新品视频")),
        "POST",
        "/v1/titles",
        {},
        False,
        {"text": "拍一条新品视频"},
        200,
        {"title": None},
        TitleOut(title=None),
    ),
}


@pytest.mark.parametrize("case", CASES.values(), ids=CASES.keys())
async def test_each_method_sends_its_route_and_parses_the_reply(
    client: RuntimeClient, recorder: Recorder, case: Case
) -> None:
    recorder.reply = lambda _r: (
        httpx.Response(case.status)
        if case.reply is None
        else httpx.Response(case.status, json=case.reply)
    )

    result = await case.call(client)

    request = recorder.last
    assert (request.method, request.url.raw_path.decode().split("?")[0]) == (
        case.method,
        case.path,
    )
    assert dict(request.url.params) == case.params
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers.get("x-end-user") == (str(OWNER) if case.owner else None)
    if case.body is None:
        assert request.content == b""
    else:
        assert request.headers["content-type"] == "application/json"
        assert json.loads(request.content) == case.body
    assert result == case.expected


async def test_a_prompt_goes_out_with_snake_case_envelope_and_camel_case_parts(
    client: RuntimeClient, recorder: Recorder
) -> None:
    recorder.reply = lambda _r: httpx.Response(200, json=_dumped(PROMPT))
    body = SessionPromptIn(
        prompt_id="prm_1",
        content=(
            TextContent(text="第一问"),
            ImageContent(source=AttachmentSource(kind="session_media", file_id="f1")),
        ),
        user_name="logan",
        agent_id="director",
    )

    result = await client.submit_prompt(SESSION, body, owner=OWNER)

    assert json.loads(recorder.last.content) == {
        "prompt_id": "prm_1",
        "content": [
            {"type": "text", "text": "第一问"},
            {"type": "image", "source": {"kind": "session_media", "fileId": "f1"}},
        ],
        "user_name": "logan",
        "agent_id": "director",
    }
    assert recorder.last.url.path == f"/v1/sessions/{S}/prompts"
    assert recorder.last.headers["x-end-user"] == str(OWNER)
    assert result == PROMPT


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
