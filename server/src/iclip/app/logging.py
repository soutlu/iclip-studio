from __future__ import annotations

import logging
import sys
import unicodedata
from typing import Literal

import structlog
from structlog.dev import Column, KeyValueColumnFormatter
from structlog.typing import EventDict, Processor, WrappedLogger

LogFormat = Literal["console", "json"]

SERVICE_NAME = "后端"

QUIET_LOGGERS = ("procrastinate", "httpx", "watchfiles")

_SERVICE_WIDTH = 6

_CONSOLE_LOGGER_NAMES = {"uvicorn.error": "uvicorn"}

_WEBSOCKETS_LINES = frozenset({"connection open", "connection closed"})

# uvicorn 的原文；带进程号或目录的几句只有开头固定，所以按开头匹配。
_UVICORN_LIFECYCLE_LINES = (
    "Will watch for changes in these directories",
    "Started reloader process",
    "Stopping reloader process",
    "Started server process",
    "Finished server process",
    "Waiting for application startup.",
    "Waiting for application shutdown.",
    "Application shutdown complete.",
    "Shutting down",
)

_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def configure_logging(
    level: str, fmt: LogFormat, *, token_path_prefixes: tuple[str, ...] = ()
) -> None:
    """配置根日志。``token_path_prefixes`` 里每个路径前缀的下一段是凭证，访问日志里写成 ``***``。"""

    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
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
    handler.addFilter(
        _RecordFilter(console=fmt == "console", token_path_prefixes=token_path_prefixes)
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )


def _console_renderer() -> structlog.dev.ConsoleRenderer:
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
    def __init__(self, service: str) -> None:
        self._service = service + " " * max(0, _SERVICE_WIDTH - _display_width(service))

    def __call__(self, logger: WrappedLogger, name: str, event_dict: EventDict) -> EventDict:
        event_dict["service"] = self._service
        logger_name = event_dict.get("logger")
        if isinstance(logger_name, str):
            event_dict["logger"] = _CONSOLE_LOGGER_NAMES.get(logger_name, logger_name)
        return event_dict


def _display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in text)


class _RecordFilter(logging.Filter):
    def __init__(self, *, console: bool, token_path_prefixes: tuple[str, ...]) -> None:
        super().__init__()
        self._console = console
        self._token_path_prefixes = token_path_prefixes

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "uvicorn.access":
            return self._keeps_access(record)
        if record.name == "uvicorn.error" and isinstance(record.msg, str):
            if record.msg in _WEBSOCKETS_LINES:
                return False
            return not (self._console and record.msg.startswith(_UVICORN_LIFECYCLE_LINES))
        return True

    def _keeps_access(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not (isinstance(args, tuple) and len(args) == 5):
            return True
        client, method, path, version, status = args
        if path == "/healthz" and status == 200:
            return False
        routine = method not in _WRITE_METHODS and isinstance(status, int) and status < 400
        if self._console and routine:
            return False
        if isinstance(path, str):
            record.args = (client, method, self._without_token(path), version, status)
        return True

    def _without_token(self, path: str) -> str:
        for prefix in self._token_path_prefixes:
            if path.startswith(f"{prefix}/"):
                _token, slash, rest = path[len(prefix) + 1 :].partition("/")
                return f"{prefix}/***{slash}{rest}"
        return path


__all__ = ["QUIET_LOGGERS", "SERVICE_NAME", "LogFormat", "configure_logging"]
