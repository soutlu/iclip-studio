"""运行时服务的日志配置：单个 root handler 经 ProcessorFormatter 输出 console 或 JSON，contextvars 里的
上下文合并进每一条，uvicorn 的日志也走它。

后端的 ``iclip/app/logging.py`` 是做法相同的另一份：后端只能引用运行时的形状、报错与客户端库（见后端
``tests/unit/architecture/test_architecture.py``），不能引用这里，所以不合并。"""

from __future__ import annotations

import logging
import sys
import unicodedata
from typing import Literal

import structlog
from structlog.dev import Column, KeyValueColumnFormatter
from structlog.typing import EventDict, Processor, WrappedLogger

LogFormat = Literal["console", "json"]

SERVICE_NAME = "运行时"
"""console 日志里本服务的服务名列。"""

QUIET_LOGGERS = ("httpx",)
"""仅保留警告及以上级别的第三方 logger，抑制逐请求 INFO。"""

_SERVICE_WIDTH = 6
"""服务名列的显示宽度，放得下「运行时」；与后端同宽，同一终端里两个服务的后几列因此对齐。"""

_CONSOLE_LOGGER_NAMES = {"uvicorn.error": "uvicorn"}
"""uvicorn 的普通 INFO 也打在 ``uvicorn.error`` 上，console 里换个名字，免得像出错。"""

_WEBSOCKETS_LINES = frozenset({"connection open", "connection closed"})
"""websockets 借 uvicorn 传入的 ``uvicorn.error`` 打的两条，与 uvicorn 自己的 ``[accepted]`` 行重复。"""


def configure_logging(level: str, fmt: LogFormat) -> None:
    """整体替换 root 日志配置，重复调用不叠加 handler 与过滤器。服务名只在 console 格式里作为时间后的一列。"""

    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        # JSON 给机器读，保持 ISO UTC；console 给人在终端看，与同屏其他进程一样用本机时间。
        structlog.processors.TimeStamper(fmt="iso")
        if fmt == "json"
        else structlog.processors.TimeStamper(fmt="%H:%M:%S", utc=False),
    ]
    tail: list[Processor] = (
        [
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ]
        if fmt == "json"
        else [_ConsoleColumns(SERVICE_NAME), _console_renderer()]
    )
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, *tail],
        )
    )
    # 挂在每次新建的 handler 上：重复调用换掉 handler，过滤器随之换掉，不会叠加。
    handler.addFilter(_keep_record)
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        # 禁用缓存，使重新配置可应用于已使用的 logger。
        cache_logger_on_first_use=False,
    )


def _console_renderer() -> structlog.dev.ConsoleRenderer:
    """事件不补宽（structlog 按字符数补，汉字占两格，补了反而参差），时间后插一列服务名。"""

    renderer = structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty(), pad_event_to=0)
    columns = renderer.columns
    service = Column(
        "service",
        KeyValueColumnFormatter(key_style=None, value_style="", reset_style="", value_repr=str),
    )
    renderer.columns = [
        *(column for column in columns if column.key == "timestamp"),
        service,
        *(column for column in columns if column.key != "timestamp"),
    ]
    return renderer


class _ConsoleColumns:
    """console 专用：补上按显示宽度对齐的服务名，并换掉 uvicorn 的 logger 名。"""

    def __init__(self, service: str) -> None:
        # 列格式化按字符数补宽，这里按显示宽度先补好。
        self._service = service + " " * max(0, _SERVICE_WIDTH - _display_width(service))

    def __call__(self, logger: WrappedLogger, name: str, event_dict: EventDict) -> EventDict:
        event_dict["service"] = self._service
        logger_name = event_dict.get("logger")
        if isinstance(logger_name, str):
            event_dict["logger"] = _CONSOLE_LOGGER_NAMES.get(logger_name, logger_name)
        return event_dict


def _display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in text)


def _keep_record(record: logging.LogRecord) -> bool:
    """丢掉常态噪音：探活成功的访问行（生产 compose 每 15 秒探一次），以及 websockets 重复的连接行。"""

    if record.name == "uvicorn.access":
        # uvicorn 的访问行参数是 (客户端, 方法, 带查询串的路径, HTTP 版本, 状态码)。
        args = record.args
        return not (
            isinstance(args, tuple) and len(args) == 5 and args[2] == "/healthz" and args[4] == 200
        )
    if record.name == "uvicorn.error":
        return record.msg not in _WEBSOCKETS_LINES
    return True


__all__ = ["QUIET_LOGGERS", "SERVICE_NAME", "LogFormat", "configure_logging"]
