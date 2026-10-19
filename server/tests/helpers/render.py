"""整片渲染服务的测试替身。

``StubRender`` 照渲染服务的内部接口（POST / GET / DELETE ``/exports``）在内存里记任务，经
``httpx.MockTransport`` 接进应用；测试按需把任务推到别的状态、让它拒收、连不上或忘掉任务。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class StubRender:
    """内存里的渲染服务。``reject`` 给了就对 POST 答 400 ``{code, message}``；``down`` 为真时
    连不上；``server_error`` 为真时一律答 500。``cancelled`` 记下收到的每个 DELETE。"""

    exports: dict[str, dict[str, Any]] = field(default_factory=dict[str, dict[str, Any]])
    submitted: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    cancelled: list[str] = field(default_factory=list[str])
    reject: tuple[str, str] | None = None
    down: bool = False
    server_error: bool = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def advance(self, export_id: str, **state: Any) -> None:
        """把这次导出推到 ``state`` 写的样子（status、progress、queuePosition、error）。"""

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
                # 前面还有几个：先进先出，前面的就是已经收下的。
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
