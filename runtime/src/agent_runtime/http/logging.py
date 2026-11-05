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

QUIET_LOGGERS = ("httpx", "httpx2")

_SELF_HANDLED_LOGGERS = ("fastmcp",)

_SERVICE_WIDTH = 6

_CONSOLE_LOGGER_NAMES = {"uvicorn.error": "uvicorn"}

_WEBSOCKETS_LINES = frozenset({"connection open", "connection closed"})


def configure_logging(level: str, fmt: LogFormat) -> None:
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
    handler.addFilter(_keep_record)
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in _SELF_HANDLED_LOGGERS:
        own = logging.getLogger(name)
        own.handlers = []
        own.propagate = True

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


def _keep_record(record: logging.LogRecord) -> bool:
    if record.name == "uvicorn.access":
        args = record.args
        return not (
            isinstance(args, tuple) and len(args) == 5 and args[2] == "/healthz" and args[4] == 200
        )
    if record.name == "uvicorn.error":
        return record.msg not in _WEBSOCKETS_LINES
    return True


__all__ = ["QUIET_LOGGERS", "SERVICE_NAME", "LogFormat", "configure_logging"]
