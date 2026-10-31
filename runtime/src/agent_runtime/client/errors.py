"""客户端库的报错：运行时答了约定的 4xx 就还原成同类的领域错误，答不上来是 ``RuntimeUnavailable``。

领域错误照原样带着运行时信封里的 ``detail`` 与 ``code``，应用按自己的错误映射答出时与进程内调用同一个信封。
"""

from __future__ import annotations

from typing import Final

import httpx
from pydantic import BaseModel, ValidationError

from agent_runtime.errors import (
    AgentUnavailable,
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)


class RuntimeUnavailable(Exception):
    """运行时服务答不上：连不上、超时、5xx、答复体解析不了，或答了约定之外的状态码。

    不是领域错误，应用按服务不可用（503）处理。消息只有简短原因与状态码，不带应用密钥。
    """

    def __init__(self, reason: str, *, status: int | None = None) -> None:
        super().__init__(reason if status is None else f"{reason}（HTTP {status}）")
        self.reason = reason
        self.status = status
        """运行时答的状态码；没答上（连不上、超时）为空。"""


class StreamClosed(RuntimeUnavailable):
    """WebSocket 连接被关了，应用重连后按 §20 对齐。

    ``code`` 是关闭码：运行时以 ``1001`` 关（心跳超时）、``1013`` 关（出站积压溢出）、握手前 ``1008``
    （认不出应用）；网络中断、往已关的连接上发帧是 ``1006``。
    """

    def __init__(self, code: int, detail: str = "") -> None:
        super().__init__(f"实时连接已关闭：{code}" + (f" {detail}" if detail else ""))
        self.code = code
        self.detail = detail


class _ErrorEnvelope(BaseModel):
    detail: str
    code: str | None = None


_DOMAIN_BY_STATUS: Final[dict[int, type[DomainError]]] = {
    401: AuthenticationFailed,
    403: PermissionDenied,
    404: NotFound,
    409: Conflict,
    422: ValidationFailed,
}
"""与运行时服务 ``http/errors.py`` 的状态码表逐条对应。"""


def transport_failure(exc: httpx.HTTPError) -> RuntimeUnavailable:
    """没拿到答复（连不上、超时、协议错）时抛的错误；httpx 的消息里没有请求头。"""

    message = str(exc)
    return RuntimeUnavailable(
        f"请求运行时失败：{type(exc).__name__}" + (f"：{message}" if message else "")
    )


def error_for(response: httpx.Response) -> DomainError | RuntimeUnavailable:
    """把一条非 2xx 答复还原成要抛的错误。"""

    status = response.status_code
    domain = _DOMAIN_BY_STATUS.get(status)
    if domain is None:
        reason = "运行时服务出错" if status >= 500 else "运行时答了约定之外的状态码"
        return RuntimeUnavailable(reason, status=status)
    try:
        envelope = _ErrorEnvelope.model_validate_json(response.content)
    except ValidationError:
        return RuntimeUnavailable("运行时的报错答复解析不了", status=status)
    if domain is Conflict and envelope.code == AgentUnavailable.code:
        return AgentUnavailable(envelope.detail)
    error = domain(envelope.detail)
    if envelope.code is not None:
        error.code = envelope.code
    return error


__all__ = ["RuntimeUnavailable", "StreamClosed", "error_for", "transport_failure"]
