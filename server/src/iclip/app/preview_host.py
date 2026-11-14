"""按 ``Host`` 划分预览域名与应用域名，是成片工程预览的安全边界。

预览域名上运行的是工程里不可信的脚本，所以这一层放在所有中间件和路由的最外面：预览域名上只开放预览
地址，别的主机上预览地址一律不存在。不依赖哪个路由记得声明。
"""

from __future__ import annotations

from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

_NOT_FOUND = "没有这个地址"


class PreviewHostSplit:
    """``Host`` 等于预览域名时只放行 ``preview_prefix`` 下的 HTTP 请求，其余 404、WebSocket 握手拒绝；
    ``Host`` 是别的主机时 ``preview_prefix`` 下一律 404。``preview_host`` 为 None（没配置预览域名）
    时没有主机是预览域名。"""

    def __init__(self, app: ASGIApp, *, preview_host: str | None, preview_prefix: str) -> None:
        self._app = app
        self._preview_host = None if preview_host is None else preview_host.lower()
        self._prefix = preview_prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self._app(scope, receive, send)
            return
        host = Headers(scope=scope).get("host", "").lower()
        on_preview_host = self._preview_host is not None and host == self._preview_host
        path = str(scope["path"])
        under_preview = path == self._prefix or path.startswith(f"{self._prefix}/")
        allowed = on_preview_host and under_preview and scope["type"] == "http"
        if allowed or (not on_preview_host and not under_preview):
            await self._app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await WebSocketClose()(scope, receive, send)
            return
        await JSONResponse({"detail": _NOT_FOUND}, status_code=404)(scope, receive, send)


__all__ = ["PreviewHostSplit"]
