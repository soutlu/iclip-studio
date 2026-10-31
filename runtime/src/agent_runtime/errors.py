"""领域错误分类学。

各域 service 只抛这些类型；HTTP 状态码映射与异常处理器在运行时服务的 http/errors.py，
后端的 platform/http.py 与 app/errors.py 与它逐条一致。
"""

from __future__ import annotations


class DomainError(Exception):
    """所有领域错误的基类。

    ``code`` 是给调用方按类别分支用的稳定错误码，有值时随 ``detail`` 一起放进 HTTP 信封；大多数错误没有。"""

    code: str | None = None


class NotFound(DomainError):
    """资源不存在，或对当前主体不可见（不泄露存在性）。"""


class PermissionDenied(DomainError):
    """资源可见但当前主体无权操作。"""


class Conflict(DomainError):
    """并发或状态冲突（如乐观并发版本不匹配）。"""


class ValidationFailed(DomainError):
    """输入在领域规则层面无效。"""


class AuthenticationFailed(DomainError):
    """主体凭证缺失或无效。"""


class AgentUnavailable(Conflict):
    """对话固定的 agent 版本此刻装配不起来（会话没有版本、引用的模型被停用、插件已从代码里删掉等），
    消息是给人看的原因。只影响用到这个版本的对话。"""

    code = "agent_unavailable"


class HookRejected(DomainError):
    """开跑检查没放行：应用答了不该重试的非 2xx，或在重试窗口里一直没答复、一直答 502/503/504。

    消息是给人看的原因，说清是没有答复还是答了哪个状态码。只在运行驱动里抛、记在消息行上，不经 HTTP 答出去。"""

    code = "gate_rejected"


__all__ = [
    "AgentUnavailable",
    "AuthenticationFailed",
    "Conflict",
    "DomainError",
    "HookRejected",
    "NotFound",
    "PermissionDenied",
    "ValidationFailed",
]
