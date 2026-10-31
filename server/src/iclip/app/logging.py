"""后端的日志配置：渲染链、时间与噪音过滤与运行时服务共用 ``agent_runtime.http.logging`` 那一份，
这里只定后端的服务名与要压低的第三方 logger。"""

from __future__ import annotations

from agent_runtime.http.logging import LogFormat
from agent_runtime.http.logging import configure_logging as configure_service_logging

SERVICE_NAME = "后端"
"""console 日志里本服务的服务名列。"""

QUIET_LOGGERS = ("procrastinate", "httpx")
"""仅保留警告及以上级别的第三方 logger，抑制周期心跳与逐请求 INFO。"""


def configure_logging(level: str, fmt: LogFormat) -> None:
    """整体替换 root 日志配置，重复调用不叠加 handler 与过滤器。"""

    configure_service_logging(level, fmt, service=SERVICE_NAME, quiet=QUIET_LOGGERS)


__all__ = ["QUIET_LOGGERS", "SERVICE_NAME", "LogFormat", "configure_logging"]
