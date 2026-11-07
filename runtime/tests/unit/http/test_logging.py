from __future__ import annotations

import importlib
import json
import logging
import os
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
import structlog

from cue.http.logging import QUIET_LOGGERS, SERVICE_NAME, LogFormat, configure_logging


@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    quiet = {name: logging.getLogger(name).level for name in QUIET_LOGGERS}
    try:
        yield
    finally:
        root.handlers[:] = handlers
        root.setLevel(level)
        for name, saved in quiet.items():
            logging.getLogger(name).setLevel(saved)
        structlog.reset_defaults()
        structlog.contextvars.clear_contextvars()


@pytest.fixture
def kolkata_time() -> Iterator[None]:
    saved = os.environ.get("TZ")
    os.environ["TZ"] = "Asia/Kolkata"
    time.tzset()
    try:
        yield
    finally:
        if saved is None:
            del os.environ["TZ"]
        else:
            os.environ["TZ"] = saved
        time.tzset()


def _access(path: str, status: int) -> None:
    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d', "127.0.0.1:50000", "GET", path, "1.1", status
    )


@pytest.mark.usefixtures("kolkata_time")
def test_console_line_starts_with_local_time_and_service(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "console")

    before = datetime.now().strftime("%H:%M:%S")
    structlog.stdlib.get_logger("cue.test").info("生成任务提交失败", job_id="j1")
    after = datetime.now().strftime("%H:%M:%S")

    (line,) = capsys.readouterr().err.splitlines()
    clock, rest = line[:8], line[9:]
    assert clock in {before, after}
    assert clock[:5] != datetime.now(UTC).strftime("%H:%M")
    assert rest.startswith("运行时 [info")
    assert "生成任务提交失败 [cue.test] job_id=j1" in line


def test_console_shows_uvicorn_error_as_uvicorn(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO", "console")

    logging.getLogger("uvicorn.error").info("Started server process [%d]", 42)
    _access("/v1/sessions", 200)

    started, access = capsys.readouterr().err.splitlines()
    assert started.endswith("Started server process [42] [uvicorn]")
    assert "uvicorn.error" not in started
    assert access.endswith("[uvicorn.access]")


@pytest.mark.parametrize("fmt", ["console", "json"])
def test_routine_noise_is_dropped_in_both_formats(
    capsys: pytest.CaptureFixture[str], fmt: LogFormat
) -> None:
    configure_logging("INFO", fmt)

    _access("/healthz", 200)
    _access("/healthz", 503)
    _access("/v1/sessions", 200)
    ws = logging.getLogger("uvicorn.error")
    ws.info('%s - "WebSocket %s" [accepted]', "127.0.0.1:50000", "/v1/events")
    ws.info("connection open")
    ws.info("connection closed")
    logging.getLogger("httpx").info("每次请求一条")
    logging.getLogger("httpx").warning("真出事了")

    lines = capsys.readouterr().err.splitlines()
    assert len(lines) == 4
    texts = [json.loads(line)["event"] for line in lines] if fmt == "json" else lines
    err = "\n".join(texts)
    assert '"GET /healthz HTTP/1.1" 503' in err
    assert '"GET /healthz HTTP/1.1" 200' not in err
    assert '"GET /v1/sessions HTTP/1.1" 200' in err
    assert '"WebSocket /v1/events" [accepted]' in err
    assert "connection open" not in err
    assert "connection closed" not in err
    assert "每次请求一条" not in err
    assert "真出事了" in err


def test_mcp_client_logs_use_the_service_format(capsys: pytest.CaptureFixture[str]) -> None:
    importlib.import_module("cue.harness.mcp")

    configure_logging("INFO", "console")

    logging.getLogger("fastmcp.client").warning("MCP 客户端的提醒")
    logging.getLogger("httpx2").info("每次请求一条")

    (line,) = capsys.readouterr().err.splitlines()
    assert SERVICE_NAME in line
    assert line.rstrip().endswith("[fastmcp.client]")


def test_reconfiguring_does_not_stack_handlers_or_filters(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "console")
    configure_logging("INFO", "json")

    (handler,) = logging.getLogger().handlers
    assert len(handler.filters) == 1
    for name in ("uvicorn.access", "uvicorn.error"):
        assert logging.getLogger(name).filters == []
    _access("/healthz", 503)
    (line,) = capsys.readouterr().err.splitlines()
    assert json.loads(line)["logger"] == "uvicorn.access"


def test_json_lines_keep_iso_utc_and_the_original_logger(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "json")

    logging.getLogger("uvicorn.error").info("Started server process [%d]", 42)
    structlog.stdlib.get_logger("cue.test").warning("捡回中断的运行", count=2)

    foreign, ours = (json.loads(line) for line in capsys.readouterr().err.splitlines())
    assert foreign == {
        "event": "Started server process [42]",
        "logger": "uvicorn.error",
        "level": "info",
        "timestamp": foreign["timestamp"],
    }
    assert ours == {
        "event": "捡回中断的运行",
        "count": 2,
        "logger": "cue.test",
        "level": "warning",
        "timestamp": ours["timestamp"],
    }
    assert ours["timestamp"].endswith("Z")
    assert datetime.fromisoformat(ours["timestamp"]).utcoffset() == timedelta(0)
