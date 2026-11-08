from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx


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
