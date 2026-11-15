from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class StubRender:
    """渲染服务的替身：只管查进度和取消（发起导出暂停着，后端不向它提交）。``requests`` 记下收到的
    每个请求的方法和路径。"""

    exports: dict[str, dict[str, Any]] = field(default_factory=dict[str, dict[str, Any]])
    cancelled: list[str] = field(default_factory=list[str])
    requests: list[tuple[str, str]] = field(default_factory=list[tuple[str, str]])
    down: bool = False
    server_error: bool = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def accept(self, export_id: str, conversation_id: str) -> None:
        """当作这次导出早先已经交到了渲染服务、正在排队。"""

        self.exports[export_id] = {
            "id": export_id,
            "conversationId": conversation_id,
            "status": "queued",
            "progress": 0.0,
            "queuePosition": len(self.exports),
            "error": None,
        }

    def advance(self, export_id: str, **state: Any) -> None:
        self.exports[export_id].update(state)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        if self.down:
            raise httpx.ConnectError("Connection refused", request=request)
        if self.server_error:
            return httpx.Response(500, text="boom")
        path = request.url.path
        if not path.startswith("/exports/"):
            return httpx.Response(404, json={"code": "not-found", "message": "该接口不存在"})
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
