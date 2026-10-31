"""运行时服务的客户端：``/v1`` 各接口一个带类型的方法，管理接口原样透传，两条 WebSocket 的连接。

请求体与答复体照用路由的那一份（``agent_runtime.app_wire``、``agent_runtime.transcript.wire`` 与文件存储、
素材台账的形状），信封 snake_case、嵌套的 transcript 实体 camelCase。每个请求带 ``Authorization: Bearer
<应用密钥>``；会话接口里要属主的方法收 ``owner``，放进 ``X-End-User``。

报错：约定的 404、409、422 还原成同类领域错误（``detail`` 与 ``code`` 原样），401、403 是运行时不认这个
应用（``AppRejected``），其余都是 ``RuntimeUnavailable``，见 ``agent_runtime.client.errors``。任何请求都不重试：写操作重发可能重复生效，要不要重来由调用方决定。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Final, Self
from urllib.parse import quote

import httpx
from httpx_ws import AsyncWebSocketSession, WebSocketDisconnect, WebSocketUpgradeError, aconnect_ws
from pydantic import BaseModel, TypeAdapter, ValidationError

from agent_runtime.app_wire import (
    END_USER_HEADER,
    ActivitiesIn,
    ActivitiesOut,
    AgentDirectoryOut,
    BusyOut,
    FilesCopyIn,
    FilesCopyOut,
    FilesOut,
    FileWriteIn,
    MaterialsIn,
    PromptStatsOut,
    RunStatsOut,
    SessionForkIn,
    SessionOpenIn,
    SessionPromptIn,
    SessionStatsOut,
    StatsQueryIn,
    StatsSessionsIn,
    TitleIn,
    TitleOut,
    UsageStatsOut,
)
from agent_runtime.client.errors import (
    APP_REJECTION_STATUSES,
    AppRejected,
    RuntimeUnavailable,
    StreamClosed,
    app_rejection,
    error_for,
    transport_failure,
)
from agent_runtime.client.streams import EventStream, TranscriptChannel
from agent_runtime.file_store.store import FileEntry, StoredFile
from agent_runtime.material_ledger.store import Material
from agent_runtime.transcript.ops import MAIN_AGENT_ID, Prompt
from agent_runtime.transcript.wire import (
    ApprovalRequest,
    OpsCatchup,
    PromptQueueOut,
    RegenerateBody,
    RunStatusOut,
    SteerRequest,
    TranscriptPage,
)

DEFAULT_TIMEOUT: Final = httpx.Timeout(60.0, connect=5.0)
"""起标题要等模型、发消息要先装一次 agent，读写各给 60 秒；连接 5 秒连不上就算运行时不在。"""

_CONNECTION_LIMITS: Final = httpx.Limits(max_connections=None, max_keepalive_connections=20)
"""自建客户端的连接上限：总数不封顶，空闲保留数照 httpx 默认的 20。每条 WebSocket 独占一条连接直到断开，
上游连接与浏览器连接一一对应，不能被请求池封顶，否则连满后普通请求也排不上；请求的并发由应用自己约束。"""

_FILE_ENTRY = TypeAdapter(FileEntry)
_STORED_FILE = TypeAdapter(StoredFile)
_MATERIAL = TypeAdapter(Material)

_UNKNOWN_APP_CLOSE: Final = 1008
"""运行时认不出应用时在握手前关连接用的关闭码（RFC 6455 的 policy violation）。"""

AdminFiles = Mapping[str, tuple[str, bytes, str]]
"""管理接口的表单上传：字段名 →（文件名，内容，内容类型）。"""


@dataclass(frozen=True, slots=True)
class AdminResponse:
    """管理接口的原样答复：状态码、内容类型、下载时的文件名头与正文。"""

    status_code: int
    content: bytes
    content_type: str | None
    content_disposition: str | None


def _segment(value: str) -> str:
    """路径里的一段：整段转义，``/`` 也转。"""

    return quote(value, safe="")


def _file_path(path: str) -> str:
    """工作区文件路径：按 ``/`` 分段转义；``.`` 与 ``..`` 段也转义，免得被 URL 规范化吃掉、请求落到别的
    路由上，交给运行时按非法路径答 422。"""

    return "/".join(
        segment.replace(".", "%2E") if segment in {".", ".."} else _segment(segment)
        for segment in path.split("/")
    )


def _parse[T](response: httpx.Response, parse: Callable[[bytes], T]) -> T:
    try:
        return parse(response.content)
    except ValidationError as exc:
        raise RuntimeUnavailable("运行时的答复体解析不了", status=response.status_code) from exc


class RuntimeClient:
    """运行时服务 ``/v1`` 的客户端，给应用的服务端（BFF）用。

    ``base_url`` 是运行时服务的根地址（不含 ``/v1``），``app_key`` 是这个应用的密钥。``http`` 给了就用它
    发请求、连接上限与关闭都归调用方，不给就自己建一个（``transport`` 是给它的传输层，测试用来接
    ``httpx.ASGITransport`` 或 ``httpx_ws.transport.ASGIWebSocketTransport``）。``timeout`` 用在每个请求
    与 WebSocket 握手上。

    用 ``async with`` 或在用完时 ``aclose``；两条 WebSocket 的连接经 ``connect_transcript`` 与
    ``connect_events``。
    """

    def __init__(
        self,
        base_url: str,
        app_key: str,
        *,
        http: httpx.AsyncClient | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
    ) -> None:
        if http is not None and transport is not None:
            raise ValueError("给了 http 客户端就由它带传输层，不能再给 transport")
        self._base = base_url.rstrip("/")
        self._key = app_key
        self._timeout = timeout
        self._owns_http = http is None
        self._http = (
            http
            if http is not None
            else httpx.AsyncClient(transport=transport, limits=_CONNECTION_LIMITS)
        )

    async def __aenter__(self) -> Self:
        if self._owns_http:
            await self._http.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if not self._owns_http:
            return
        # 经 __aexit__ 关：ASGIWebSocketTransport 的任务组只在这里收。它把穿过的异常包成只有这一个成员的
        # 异常组；包的正是体里抛出的那个时不接这个组，让原异常照常往外抛。
        try:
            await self._http.__aexit__(exc_type, exc, tb)
        except BaseExceptionGroup as group:
            if exc is None or len(group.exceptions) != 1 or group.exceptions[0] is not exc:
                raise

    async def aclose(self) -> None:
        """不用 ``async with`` 时用完调它；交进来的 ``http`` 不关。"""

        if self._owns_http:
            await self._http.aclose()

    # --- 会话 -----------------------------------------------------------------

    async def open_session(self, body: SessionOpenIn) -> None:
        """``POST /v1/sessions``：开会话，固定这个 agent 此刻的当前版本。"""

        await self._call("POST", "/v1/sessions", body=body)

    async def fork_session(
        self, source_id: uuid.UUID, body: SessionForkIn, *, owner: uuid.UUID
    ) -> None:
        """``POST /v1/sessions/{id}:fork``；``owner`` 是目标会话的属主。"""

        await self._call("POST", f"/v1/sessions/{source_id}:fork", owner=owner, body=body)

    async def copy_files(
        self, source_id: uuid.UUID, body: FilesCopyIn, *, owner: uuid.UUID
    ) -> FilesCopyOut:
        """``POST /v1/sessions/{id}/files:copy``；``owner`` 是目标会话的属主。"""

        response = await self._call(
            "POST", f"/v1/sessions/{source_id}/files:copy", owner=owner, body=body
        )
        return _parse(response, FilesCopyOut.model_validate_json)

    async def activities(self, body: ActivitiesIn) -> ActivitiesOut:
        """``POST /v1/sessions:activities``：这几段会话此刻的活动，只答本应用的会话。"""

        response = await self._call("POST", "/v1/sessions:activities", body=body)
        return _parse(response, ActivitiesOut.model_validate_json)

    async def busy(self, *, owner: uuid.UUID | None = None) -> BusyOut:
        """``GET /v1/sessions:busy``：本应用此刻占着执行位的会话；给了 ``owner`` 只算这个属主的。"""

        params = {} if owner is None else {"end_user": str(owner)}
        response = await self._call("GET", "/v1/sessions:busy", params=params)
        return _parse(response, BusyOut.model_validate_json)

    # --- 消息 -----------------------------------------------------------------

    async def submit_prompt(
        self, session_id: uuid.UUID, body: SessionPromptIn, *, owner: uuid.UUID
    ) -> Prompt:
        """``POST /v1/sessions/{id}/prompts``；装不起来 agent 是 ``AgentUnavailable``。"""

        response = await self._call(
            "POST", f"/v1/sessions/{session_id}/prompts", owner=owner, body=body
        )
        return _parse(response, Prompt.model_validate_json)

    async def prompt_queue(self, session_id: uuid.UUID) -> PromptQueueOut:
        """``GET /v1/sessions/{id}/prompts``：在跑的那条加排着的那些。"""

        response = await self._call("GET", f"/v1/sessions/{session_id}/prompts")
        return _parse(response, PromptQueueOut.model_validate_json)

    async def abort_prompt(self, session_id: uuid.UUID, prompt_id: str) -> None:
        """``POST /v1/sessions/{id}/prompts/{prompt_id}:abort``。"""

        await self._call("POST", f"/v1/sessions/{session_id}/prompts/{_segment(prompt_id)}:abort")

    async def abort_session(self, session_id: uuid.UUID) -> None:
        """``POST /v1/sessions/{id}:abort``：排着的全撤，在跑的发取消。"""

        await self._call("POST", f"/v1/sessions/{session_id}:abort")

    async def steer(self, session_id: uuid.UUID, body: SteerRequest) -> None:
        """``POST /v1/sessions/{id}/prompts:steer``。"""

        await self._call("POST", f"/v1/sessions/{session_id}/prompts:steer", body=body)

    async def regenerate(
        self, session_id: uuid.UUID, turn_id: str, body: RegenerateBody | None = None
    ) -> Prompt:
        """``POST /v1/sessions/{id}/turns/{turn_id}:regenerate``；``body`` 不给就不带请求体。"""

        response = await self._call(
            "POST", f"/v1/sessions/{session_id}/turns/{_segment(turn_id)}:regenerate", body=body
        )
        return _parse(response, Prompt.model_validate_json)

    async def approve(
        self, session_id: uuid.UUID, interaction_id: str, body: ApprovalRequest
    ) -> None:
        """``POST /v1/sessions/{id}/interactions/{interaction_id}``。"""

        await self._call(
            "POST", f"/v1/sessions/{session_id}/interactions/{_segment(interaction_id)}", body=body
        )

    # --- 状态与 transcript ------------------------------------------------------

    async def run_status(self, session_id: uuid.UUID) -> RunStatusOut:
        """``GET /v1/sessions/{id}/status``。"""

        response = await self._call("GET", f"/v1/sessions/{session_id}/status")
        return _parse(response, RunStatusOut.model_validate_json)

    async def transcript_page(
        self,
        session_id: uuid.UUID,
        *,
        session_agent: str,
        agent: str = MAIN_AGENT_ID,
        before_turn: str | None = None,
        after_turn: str | None = None,
        page_size: int | None = None,
    ) -> TranscriptPage:
        """``GET /v1/sessions/{id}/transcript``；``session_agent`` 是这段会话的 agent id。"""

        params: dict[str, str | int] = {"session_agent": session_agent, "agent": agent}
        if before_turn is not None:
            params["before_turn"] = before_turn
        if after_turn is not None:
            params["after_turn"] = after_turn
        if page_size is not None:
            params["page_size"] = page_size
        response = await self._call("GET", f"/v1/sessions/{session_id}/transcript", params=params)
        return _parse(response, TranscriptPage.model_validate_json)

    async def transcript_ops(
        self,
        session_id: uuid.UUID,
        *,
        since_seq: int,
        agent: str = MAIN_AGENT_ID,
        stream_epoch: str | None = None,
    ) -> OpsCatchup:
        """``GET /v1/sessions/{id}/transcript/ops``：补 ``since_seq`` 之后的批次。"""

        params: dict[str, str | int] = {"since_seq": since_seq, "agent": agent}
        if stream_epoch is not None:
            params["stream_epoch"] = stream_epoch
        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/transcript/ops", params=params
        )
        return _parse(response, OpsCatchup.model_validate_json)

    # --- 工作区与素材台账 ---------------------------------------------------------

    async def list_files(
        self, session_id: uuid.UUID, *, owner: uuid.UUID, prefix: str = ""
    ) -> FilesOut:
        """``GET /v1/sessions/{id}/files``；``prefix`` 不给列全部。"""

        params = {"prefix": prefix} if prefix else {}
        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/files", owner=owner, params=params
        )
        return _parse(response, FilesOut.model_validate_json)

    async def read_file(self, session_id: uuid.UUID, path: str, *, owner: uuid.UUID) -> StoredFile:
        """``GET /v1/sessions/{id}/files/{path}``；文件不在是 ``NotFound``。"""

        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/files/{_file_path(path)}", owner=owner
        )
        return _parse(response, _STORED_FILE.validate_json)

    async def write_file(
        self, session_id: uuid.UUID, path: str, body: FileWriteIn, *, owner: uuid.UUID
    ) -> FileEntry:
        """``PUT /v1/sessions/{id}/files/{path}``：整份覆盖；版本对不上是 ``Conflict``。"""

        response = await self._call(
            "PUT", f"/v1/sessions/{session_id}/files/{_file_path(path)}", owner=owner, body=body
        )
        return _parse(response, _FILE_ENTRY.validate_json)

    async def record_materials(
        self, session_id: uuid.UUID, body: MaterialsIn, *, owner: uuid.UUID
    ) -> None:
        """``POST /v1/sessions/{id}/materials``。"""

        await self._call("POST", f"/v1/sessions/{session_id}/materials", owner=owner, body=body)

    async def lookup_material(
        self, session_id: uuid.UUID, url: str, *, owner: uuid.UUID
    ) -> Material:
        """``GET /v1/sessions/{id}/materials?url=``；没登记过是 ``NotFound``。"""

        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/materials", owner=owner, params={"url": url}
        )
        return _parse(response, _MATERIAL.validate_json)

    # --- agent 名册与起标题 --------------------------------------------------------

    async def agents(self) -> AgentDirectoryOut:
        """``GET /v1/agents``：首页能选的顶层 agent。"""

        response = await self._call("GET", "/v1/agents")
        return _parse(response, AgentDirectoryOut.model_validate_json)

    async def generate_title(self, body: TitleIn) -> TitleOut:
        """``POST /v1/titles``：用默认对话模型起标题，起不出 ``title`` 为空。"""

        response = await self._call("POST", "/v1/titles", body=body)
        return _parse(response, TitleOut.model_validate_json)

    # --- 运行统计 --------------------------------------------------------------

    async def stats_prompts(self, body: StatsQueryIn) -> PromptStatsOut:
        """``POST /v1/stats/prompts``：本应用会话的消息，按时间窗或按会话取。"""

        response = await self._call("POST", "/v1/stats/prompts", body=body)
        return _parse(response, PromptStatsOut.model_validate_json)

    async def stats_runs(self, body: StatsQueryIn) -> RunStatsOut:
        """``POST /v1/stats/runs``：本应用会话里跑到终态的顶层运行。"""

        response = await self._call("POST", "/v1/stats/runs", body=body)
        return _parse(response, RunStatsOut.model_validate_json)

    async def stats_usage(self, body: StatsQueryIn) -> UsageStatsOut:
        """``POST /v1/stats/usage``：本应用会话按模型的累计用量。"""

        response = await self._call("POST", "/v1/stats/usage", body=body)
        return _parse(response, UsageStatsOut.model_validate_json)

    async def stats_sessions(self, body: StatsSessionsIn) -> SessionStatsOut:
        """``POST /v1/stats/sessions``：这几段会话里跑过的那些的首末消息。"""

        response = await self._call("POST", "/v1/stats/sessions", body=body)
        return _parse(response, SessionStatsOut.model_validate_json)

    # --- 管理接口透传 ------------------------------------------------------------

    async def admin_request(
        self,
        method: str,
        path: str,
        *,
        end_user: uuid.UUID | None = None,
        params: Mapping[str, str | Sequence[str]] | None = None,
        json: Any = None,
        content: bytes | None = None,
        files: AdminFiles | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AdminResponse:
        """把一个管理请求原样转给 ``/v1/admin/<path>``，答复原样交回。

        ``path`` 是 ``/v1/admin/`` 下面那一截、已转义好的写法（照浏览器请求里的原样），不能有 ``.`` 与
        ``..`` 段、``?`` 与 ``#``；查询参数放 ``params``。``end_user`` 是代办用户，写操作要给。请求体
        ``json``、``content``（原样的字节，内容类型放 ``headers``）与 ``files``（表单上传）至多给一个。
        ``headers`` 里的 ``Authorization`` 与 ``X-End-User`` 不用：密钥是本客户端的，代办用户只看
        ``end_user``，不给就不带。

        401、403 抛 ``AppRejected``：说的是这个应用的密钥与权限，不是代办用户，不交给浏览器；其余 4xx 不抛，
        状态码与正文原样交回；5xx、连不上、超时抛 ``RuntimeUnavailable``。
        """

        relative = path.lstrip("/")
        if (
            "?" in relative
            or "#" in relative
            or any(segment in {".", ".."} for segment in relative.split("/"))
        ):
            raise ValueError(f"管理接口的路径不合规：{path!r}")
        if sum(part is not None for part in (json, content, files)) > 1:
            raise ValueError("json、content 与 files 至多给一个")
        merged = httpx.Headers(headers)
        # 代办用户只按 end_user 给：调用方 headers 里带的不转，免得被冒用。
        merged.pop(END_USER_HEADER, None)
        merged.update(self._auth_headers(end_user))
        try:
            response = await self._http.request(
                method,
                f"{self._base}/v1/admin/{relative}",
                params=params,
                json=json,
                content=content,
                files=files,
                headers=merged,
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise transport_failure(exc) from exc
        if response.status_code >= 500:
            raise RuntimeUnavailable("运行时服务出错", status=response.status_code)
        if response.status_code in APP_REJECTION_STATUSES:
            raise app_rejection(response)
        return AdminResponse(
            status_code=response.status_code,
            content=response.content,
            content_type=response.headers.get("content-type"),
            content_disposition=response.headers.get("content-disposition"),
        )

    # --- WebSocket ------------------------------------------------------------

    @asynccontextmanager
    async def connect_transcript(self) -> AsyncGenerator[TranscriptChannel]:
        """连上对话内容流 ``/v1/ws``；退出时关连接，运行时撤掉它的全部订阅。"""

        async with self._connect("/v1/ws") as ws:
            yield TranscriptChannel(ws)

    @asynccontextmanager
    async def connect_events(self) -> AsyncGenerator[EventStream]:
        """连上应用事件流 ``/v1/events``，``async for`` 收会话活动。"""

        async with self._connect("/v1/events") as ws:
            yield EventStream(ws)

    @asynccontextmanager
    async def _connect(self, path: str) -> AsyncGenerator[AsyncWebSocketSession]:
        """握手并交出连接。握手失败：认不出应用是 ``AppRejected``（在 ASGI 传输层上是握手前以 ``1008`` 关，
        经 ASGI 服务器是它代答的 HTTP 403），握手前以别的关闭码关是 ``StreamClosed``，答了别的状态码、连不上
        是 ``RuntimeUnavailable``。

        httpx-ws 的会话里有任务组，从 ``async with`` 体里抛出的异常会被包成只有一个成员的异常组；这里拆开，
        调用方照常按类型接。"""

        connected = False
        try:
            async with aconnect_ws(
                f"{self._base}{path}",
                self._http,
                headers=self._auth_headers(None),
                timeout=self._timeout,
            ) as ws:
                connected = True
                yield ws
        except BaseExceptionGroup as group:
            if len(group.exceptions) == 1:
                raise group.exceptions[0] from None
            raise
        except WebSocketDisconnect as exc:
            if connected:
                raise
            if exc.code == _UNKNOWN_APP_CLOSE:
                raise AppRejected(exc.reason, status=None) from exc
            raise StreamClosed(exc.code, exc.reason) from exc
        except WebSocketUpgradeError as exc:
            if connected:
                raise
            status = exc.response.status_code
            if status in APP_REJECTION_STATUSES:
                # 握手的答复正文没读进来，原因只有状态码。
                raise AppRejected("", status=status) from exc
            raise RuntimeUnavailable("运行时拒绝了实时连接", status=status) from exc
        except httpx.HTTPError as exc:
            if connected:
                raise
            raise transport_failure(exc) from exc

    # --- 内部 -----------------------------------------------------------------

    def _auth_headers(self, owner: uuid.UUID | None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self._key}"}
        if owner is not None:
            headers[END_USER_HEADER] = str(owner)
        return headers

    async def _call(
        self,
        method: str,
        path: str,
        *,
        owner: uuid.UUID | None = None,
        params: Mapping[str, str | int] | None = None,
        body: BaseModel | None = None,
    ) -> httpx.Response:
        """发一个带类型方法的请求：2xx 交回答复，其余按 ``error_for`` 抛。"""

        headers = self._auth_headers(owner)
        content: str | None = None
        if body is not None:
            # 信封 snake_case、嵌套实体按别名（camelCase）；空字段省略，与运行时自己发帧同一个写法。
            content = body.model_dump_json(exclude_none=True, by_alias=True)
            headers["Content-Type"] = "application/json"
        try:
            response = await self._http.request(
                method,
                f"{self._base}{path}",
                params=params,
                content=content,
                headers=headers,
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise transport_failure(exc) from exc
        if response.is_success:
            return response
        raise error_for(response)


__all__ = ["DEFAULT_TIMEOUT", "AdminFiles", "AdminResponse", "RuntimeClient"]
