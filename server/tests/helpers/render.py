from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

_REWRITTEN = "<!doctype html>"


def film_file(
    *videos: tuple[uuid.UUID, str],
    audios: Sequence[tuple[uuid.UUID, str]] = (),
    duration_ms: int = 5000,
) -> str:
    """测试里的成片文件。后端不读文件内容，只看渲染服务的检查结果；``StubRender`` 按这里写下的
    素材（视频片段的视频、音频片段的音频）和时长答复。"""

    def sources(kind: str, found: Sequence[tuple[uuid.UUID, str]]) -> list[dict[str, str]]:
        return [{"jobId": str(job_id), "url": url, "kind": kind} for job_id, url in found]

    return json.dumps(
        {"sources": sources("video", videos) + sources("audio", audios), "durationMs": duration_ms}
    )


def rewritten(film: str) -> str:
    """``StubRender`` 检查后答复的那一份，对应真实渲染服务按写法重写后的文件。"""

    return film if film.startswith(_REWRITTEN) else _REWRITTEN + film


@dataclass
class StubRender:
    exports: dict[str, dict[str, Any]] = field(default_factory=dict[str, dict[str, Any]])
    submitted: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    cancelled: list[str] = field(default_factory=list[str])
    reject: tuple[str, str] | None = None
    down: bool = False
    server_error: bool = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def advance(self, export_id: str, **state: Any) -> None:
        self.exports[export_id].update(state)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("Connection refused", request=request)
        if self.server_error:
            return httpx.Response(500, text="boom")
        path = request.url.path
        if request.method == "POST" and path == "/films/check":
            film = json.loads(request.content)["film"]
            try:
                found = json.loads(film.removeprefix(_REWRITTEN))
            except ValueError:
                return httpx.Response(
                    400, json={"code": "invalid-film", "message": "成片文件不合写法"}
                )
            return httpx.Response(200, json={"html": rewritten(film), **found})
        if request.method == "POST" and path == "/exports":
            payload = json.loads(request.content)
            if self.reject is not None:
                code, message = self.reject
                return httpx.Response(400, json={"code": code, "message": message})
            self.submitted.append(payload)
            self.exports[payload["id"]] = {
                "id": payload["id"],
                "conversationId": payload["conversationId"],
                "status": "queued",
                "progress": 0.0,
                "queuePosition": len(self.exports),
                "error": None,
            }
            return httpx.Response(202, json={"id": payload["id"]})
        export_id = path.removeprefix("/exports/")
        if request.method == "DELETE":
            self.cancelled.append(export_id)
        found = self.exports.get(export_id)
        if found is None:
            return httpx.Response(404, json={"code": "not-found", "message": "没有这个导出"})
        if request.method == "GET":
            return httpx.Response(200, json=found)
        if request.method == "DELETE":
            if found["status"] in {"queued", "rendering", "uploading"}:
                found.update(status="cancelled", queuePosition=None)
            return httpx.Response(204)
        return httpx.Response(405)


__all__ = ["StubRender"]
