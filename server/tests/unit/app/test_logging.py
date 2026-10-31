"""后端的日志配置：console 的列、时间与 logger 名，两种格式共有的噪音过滤，JSON 的形状，以及请求上下文。"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
import structlog

from iclip.app.logging import QUIET_LOGGERS, LogFormat, configure_logging


@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    """恢复 root handler 与被压低的 logger，避免 configure_logging 影响 pytest 日志捕获。"""

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
    """本机时区换成与 UTC 差半小时的 Asia/Kolkata：无论何时跑，本地时间与 UTC 的分钟都不同。"""

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
    """按 uvicorn 访问行的参数形状打一条。"""

    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d', "127.0.0.1:50000", "GET", path, "1.1", status
    )


@pytest.mark.usefixtures("kolkata_time")
def test_console_line_starts_with_local_time_and_service(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "console")

    before = datetime.now().strftime("%H:%M:%S")
    structlog.stdlib.get_logger("iclip.test").info("生成任务提交失败", job_id="j1")
    after = datetime.now().strftime("%H:%M:%S")

    (line,) = capsys.readouterr().err.splitlines()
    clock, rest = line[:8], line[9:]
    assert clock in {before, after}
    assert clock[:5] != datetime.now(UTC).strftime("%H:%M")
    # 「后端」按显示宽度补到 6 格，与运行时的「运行时」同宽，级别列在两个服务里对齐。
    assert rest.startswith("后端   [info")
    # 事件后只隔一个空格就是 logger 列，不按字符数补宽。
    assert "生成任务提交失败 [iclip.test] job_id=j1" in line


def test_console_shows_uvicorn_error_as_uvicorn(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO", "console")

    logging.getLogger("uvicorn.error").info("Started server process [%d]", 42)
    _access("/api/conversations", 200)

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
    _access("/api/conversations", 200)
    ws = logging.getLogger("uvicorn.error")
    ws.info('%s - "WebSocket %s" [accepted]', "127.0.0.1:50000", "/ws")
    ws.info("connection open")
    ws.info("connection closed")
    logging.getLogger("procrastinate.worker").info("Starting job")
    logging.getLogger("procrastinate.worker").warning("Job failed")

    lines = capsys.readouterr().err.splitlines()
    assert len(lines) == 4
    # JSON 里的引号被转义，按事件原文比对。
    texts = [json.loads(line)["event"] for line in lines] if fmt == "json" else lines
    err = "\n".join(texts)
    assert '"GET /healthz HTTP/1.1" 503' in err
    assert '"GET /healthz HTTP/1.1" 200' not in err
    assert '"GET /api/conversations HTTP/1.1" 200' in err
    assert '"WebSocket /ws" [accepted]' in err
    assert "connection open" not in err
    assert "connection closed" not in err
    assert "Starting job" not in err
    assert "Job failed" in err


def test_reconfiguring_does_not_stack_handlers_or_filters(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """监督进程与 worker 各配一次。"""

    configure_logging("INFO", "console")
    configure_logging("INFO", "json")

    (handler,) = logging.getLogger().handlers
    assert len(handler.filters) == 1
    for name in ("uvicorn.access", "uvicorn.error"):
        assert logging.getLogger(name).filters == []
    _access("/healthz", 503)
    (line,) = capsys.readouterr().err.splitlines()
    assert json.loads(line)["logger"] == "uvicorn.access"


def test_json_lines_keep_iso_utc_and_carry_request_context(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "json")
    structlog.contextvars.bind_contextvars(request_id="req-1")

    _access("/x", 200)
    structlog.stdlib.get_logger("iclip.test").warning("捡回中断的生成任务", count=2)

    access, ours = (json.loads(line) for line in capsys.readouterr().err.splitlines())
    assert access == {
        "event": '127.0.0.1:50000 - "GET /x HTTP/1.1" 200',
        "logger": "uvicorn.access",
        "level": "info",
        "request_id": "req-1",
        "timestamp": access["timestamp"],
    }
    assert ours == {
        "event": "捡回中断的生成任务",
        "count": 2,
        "logger": "iclip.test",
        "level": "warning",
        "request_id": "req-1",
        "timestamp": ours["timestamp"],
    }
    assert ours["timestamp"].endswith("Z")
    assert datetime.fromisoformat(ours["timestamp"]).utcoffset() == timedelta(0)
