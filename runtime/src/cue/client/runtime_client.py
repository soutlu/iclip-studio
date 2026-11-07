from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Final, Protocol, Self
from urllib.parse import quote

import httpx
from httpx_ws import AsyncWebSocketSession, WebSocketDisconnect, WebSocketUpgradeError, aconnect_ws
from pydantic import BaseModel, TypeAdapter, ValidationError
from pydantic.config import ExtraValues

from cue.app_wire import (
    END_USER_HEADER,
    UPSTREAM_TIMEOUT_CODE,
    UPSTREAM_UNREACHABLE_CODE,
    ActivitiesIn,
    ActivitiesOut,
    AgentDirectoryOut,
    BusyOut,
    FilesCopyIn,
    FilesCopyOut,
    FilesOut,
    FileWriteIn,
    ModelCallIn,
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
from cue.client.errors import (
    APP_REJECTION_STATUSES,
    AppRejected,
    ModelCallTimedOut,
    RuntimeUnavailable,
    StreamClosed,
    app_rejection,
    envelope_code,
    error_for,
    transport_failure,
)
from cue.client.streams import EventStream, TranscriptChannel
from cue.errors import ModelUnavailable
from cue.file_store.store import FileEntry, StoredFile
from cue.transcript.ops import MAIN_AGENT_ID, Prompt
from cue.transcript.wire import (
    ApprovalRequest,
    OpsCatchup,
    PromptQueueOut,
    RegenerateBody,
    RunStatusOut,
    SteerRequest,
    TranscriptPage,
)

DEFAULT_TIMEOUT: Final = httpx.Timeout(60.0, connect=5.0)

_CONNECTION_LIMITS: Final = httpx.Limits(max_connections=None, max_keepalive_connections=20)

_FILE_ENTRY = TypeAdapter(FileEntry)
_STORED_FILE = TypeAdapter(StoredFile)

_UNKNOWN_APP_CLOSE: Final = 1008

AdminFiles = Mapping[str, tuple[str, bytes, str]]


@dataclass(frozen=True, slots=True)
class AdminResponse:
    status_code: int
    content: bytes
    content_type: str | None
    content_disposition: str | None


@dataclass(frozen=True, slots=True)
class ModelCallResponse:
    status_code: int
    content: bytes
    content_type: str | None


def _segment(value: str) -> str:
    return quote(value, safe="")


def _file_path(path: str) -> str:
    return "/".join(
        segment.replace(".", "%2E") if segment in {".", ".."} else _segment(segment)
        for segment in path.split("/")
    )


class _Parser[T](Protocol):
    def __call__(self, data: bytes, /, *, extra: ExtraValues | None) -> T: ...


def _parse[T](response: httpx.Response, parse: _Parser[T]) -> T:
    try:
        return parse(response.content, extra="ignore")
    except ValidationError as exc:
        raise RuntimeUnavailable("运行时的答复体解析不了", status=response.status_code) from exc


class RuntimeClient:
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
        try:
            await self._http.__aexit__(exc_type, exc, tb)
        except BaseExceptionGroup as group:
            if exc is None or len(group.exceptions) != 1 or group.exceptions[0] is not exc:
                raise

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def open_session(self, body: SessionOpenIn) -> None:
        await self._call("POST", "/v1/sessions", body=body)

    async def fork_session(
        self, source_id: uuid.UUID, body: SessionForkIn, *, owner: uuid.UUID
    ) -> None:
        await self._call("POST", f"/v1/sessions/{source_id}:fork", owner=owner, body=body)

    async def copy_files(
        self, source_id: uuid.UUID, body: FilesCopyIn, *, owner: uuid.UUID
    ) -> FilesCopyOut:
        response = await self._call(
            "POST", f"/v1/sessions/{source_id}/files:copy", owner=owner, body=body
        )
        return _parse(response, FilesCopyOut.model_validate_json)

    async def activities(self, body: ActivitiesIn) -> ActivitiesOut:
        response = await self._call("POST", "/v1/sessions:activities", body=body)
        return _parse(response, ActivitiesOut.model_validate_json)

    async def busy(self, *, owner: uuid.UUID | None = None) -> BusyOut:
        params = {} if owner is None else {"end_user": str(owner)}
        response = await self._call("GET", "/v1/sessions:busy", params=params)
        return _parse(response, BusyOut.model_validate_json)

    async def submit_prompt(
        self, session_id: uuid.UUID, body: SessionPromptIn, *, owner: uuid.UUID
    ) -> Prompt:
        response = await self._call(
            "POST", f"/v1/sessions/{session_id}/prompts", owner=owner, body=body
        )
        return _parse(response, Prompt.model_validate_json)

    async def prompt_queue(self, session_id: uuid.UUID) -> PromptQueueOut:
        response = await self._call("GET", f"/v1/sessions/{session_id}/prompts")
        return _parse(response, PromptQueueOut.model_validate_json)

    async def abort_prompt(self, session_id: uuid.UUID, prompt_id: str) -> None:
        await self._call("POST", f"/v1/sessions/{session_id}/prompts/{_segment(prompt_id)}:abort")

    async def abort_session(self, session_id: uuid.UUID) -> None:
        await self._call("POST", f"/v1/sessions/{session_id}:abort")

    async def steer(self, session_id: uuid.UUID, body: SteerRequest) -> None:
        await self._call("POST", f"/v1/sessions/{session_id}/prompts:steer", body=body)

    async def regenerate(
        self, session_id: uuid.UUID, turn_id: str, body: RegenerateBody | None = None
    ) -> Prompt:
        response = await self._call(
            "POST", f"/v1/sessions/{session_id}/turns/{_segment(turn_id)}:regenerate", body=body
        )
        return _parse(response, Prompt.model_validate_json)

    async def approve(
        self, session_id: uuid.UUID, interaction_id: str, body: ApprovalRequest
    ) -> None:
        await self._call(
            "POST", f"/v1/sessions/{session_id}/interactions/{_segment(interaction_id)}", body=body
        )

    async def run_status(self, session_id: uuid.UUID) -> RunStatusOut:
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
        params: dict[str, str | int] = {"since_seq": since_seq, "agent": agent}
        if stream_epoch is not None:
            params["stream_epoch"] = stream_epoch
        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/transcript/ops", params=params
        )
        return _parse(response, OpsCatchup.model_validate_json)

    async def list_files(
        self, session_id: uuid.UUID, *, owner: uuid.UUID, prefix: str = ""
    ) -> FilesOut:
        params = {"prefix": prefix} if prefix else {}
        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/files", owner=owner, params=params
        )
        return _parse(response, FilesOut.model_validate_json)

    async def read_file(self, session_id: uuid.UUID, path: str, *, owner: uuid.UUID) -> StoredFile:
        response = await self._call(
            "GET", f"/v1/sessions/{session_id}/files/{_file_path(path)}", owner=owner
        )
        return _parse(response, _STORED_FILE.validate_json)

    async def write_file(
        self, session_id: uuid.UUID, path: str, body: FileWriteIn, *, owner: uuid.UUID
    ) -> FileEntry:
        response = await self._call(
            "PUT", f"/v1/sessions/{session_id}/files/{_file_path(path)}", owner=owner, body=body
        )
        return _parse(response, _FILE_ENTRY.validate_json)

    async def agents(self) -> AgentDirectoryOut:
        response = await self._call("GET", "/v1/agents")
        return _parse(response, AgentDirectoryOut.model_validate_json)

    async def generate_title(self, body: TitleIn) -> TitleOut:
        response = await self._call("POST", "/v1/titles", body=body)
        return _parse(response, TitleOut.model_validate_json)

    async def model_call(self, body: ModelCallIn, *, timeout: httpx.Timeout) -> ModelCallResponse:
        headers = self._auth_headers(None)
        headers["Content-Type"] = "application/json"
        try:
            response = await self._http.request(
                "POST",
                f"{self._base}/v1/model-calls/responses",
                content=body.model_dump_json(),
                headers=headers,
                timeout=timeout,
            )
        except httpx.TimeoutException as exc:
            raise ModelCallTimedOut(f"等运行时答复超时：{type(exc).__name__}") from exc
        except httpx.HTTPError as exc:
            raise transport_failure(exc) from exc
        status = response.status_code
        if status in APP_REJECTION_STATUSES:
            raise app_rejection(response)
        code = envelope_code(response)
        if status == 409 and code == ModelUnavailable.code:
            raise error_for(response)
        if status == 504 and code == UPSTREAM_TIMEOUT_CODE:
            raise ModelCallTimedOut("运行时等上游答复超时", status=status)
        if status == 502 and code == UPSTREAM_UNREACHABLE_CODE:
            raise RuntimeUnavailable("运行时连不上上游", status=status)
        return ModelCallResponse(
            status_code=status,
            content=response.content,
            content_type=response.headers.get("content-type"),
        )

    async def stats_prompts(self, body: StatsQueryIn) -> PromptStatsOut:
        response = await self._call("POST", "/v1/stats/prompts", body=body)
        return _parse(response, PromptStatsOut.model_validate_json)

    async def stats_runs(self, body: StatsQueryIn) -> RunStatsOut:
        response = await self._call("POST", "/v1/stats/runs", body=body)
        return _parse(response, RunStatsOut.model_validate_json)

    async def stats_usage(self, body: StatsQueryIn) -> UsageStatsOut:
        response = await self._call("POST", "/v1/stats/usage", body=body)
        return _parse(response, UsageStatsOut.model_validate_json)

    async def stats_sessions(self, body: StatsSessionsIn) -> SessionStatsOut:
        response = await self._call("POST", "/v1/stats/sessions", body=body)
        return _parse(response, SessionStatsOut.model_validate_json)

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

    @asynccontextmanager
    async def connect_transcript(self) -> AsyncGenerator[TranscriptChannel]:
        async with self._connect("/v1/ws") as ws:
            yield TranscriptChannel(ws)

    @asynccontextmanager
    async def connect_events(self) -> AsyncGenerator[EventStream]:
        async with self._connect("/v1/events") as ws:
            yield EventStream(ws)

    @asynccontextmanager
    async def _connect(self, path: str) -> AsyncGenerator[AsyncWebSocketSession]:
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
                raise AppRejected("", status=status) from exc
            raise RuntimeUnavailable("运行时拒绝了实时连接", status=status) from exc
        except httpx.HTTPError as exc:
            if connected:
                raise
            raise transport_failure(exc) from exc

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
        headers = self._auth_headers(owner)
        content: str | None = None
        if body is not None:
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


__all__ = ["DEFAULT_TIMEOUT", "AdminFiles", "AdminResponse", "ModelCallResponse", "RuntimeClient"]
