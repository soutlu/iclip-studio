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


def _access(path: str, status: int, method: str = "GET") -> None:
    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d', "127.0.0.1:50000", method, path, "1.1", status
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
    assert rest.startswith("后端   [info")
    assert "生成任务提交失败 [iclip.test] job_id=j1" in line


def test_console_shows_uvicorn_error_as_uvicorn(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO", "console")

    logging.getLogger("uvicorn.error").info("Application startup complete.")
    _access("/conversations", 404)

    ready, access = capsys.readouterr().err.splitlines()
    assert ready.endswith("Application startup complete. [uvicorn]")
    assert "uvicorn.error" not in ready
    assert access.endswith("[uvicorn.access]")


@pytest.mark.parametrize("fmt", ["console", "json"])
def test_routine_noise_is_dropped_in_both_formats(
    capsys: pytest.CaptureFixture[str], fmt: LogFormat
) -> None:
    configure_logging("INFO", fmt)

    _access("/healthz", 200)
    _access("/healthz", 503)
    ws = logging.getLogger("uvicorn.error")
    ws.info('%s - "WebSocket %s" [accepted]', "127.0.0.1:50000", "/ws")
    ws.info("connection open")
    ws.info("connection closed")
    logging.getLogger("procrastinate.worker").info("Starting job")
    logging.getLogger("procrastinate.worker").warning("Job failed")
    logging.getLogger("watchfiles.main").info("%d change%s detected", 3, "s")

    lines = capsys.readouterr().err.splitlines()
    assert len(lines) == 3
    texts = [json.loads(line)["event"] for line in lines] if fmt == "json" else lines
    err = "\n".join(texts)
    assert '"GET /healthz HTTP/1.1" 503' in err
    assert '"GET /healthz HTTP/1.1" 200' not in err
    assert '"WebSocket /ws" [accepted]' in err
    assert "connection open" not in err
    assert "connection closed" not in err
    assert "Starting job" not in err
    assert "Job failed" in err
    assert "changes detected" not in err


def test_console_shows_only_writes_and_failures_among_access_lines(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "console")

    _access("/conversations", 200)
    _access("/assets/cover.png", 304)
    _access("/conversations/c1/prompts", 202, "POST")
    _access("/conversations/c1", 204, "DELETE")
    _access("/conversations/c1/files/notes.md", 404)

    posted, deleted, missing = capsys.readouterr().err.splitlines()
    assert '"POST /conversations/c1/prompts HTTP/1.1" 202' in posted
    assert '"DELETE /conversations/c1 HTTP/1.1" 204' in deleted
    assert '"GET /conversations/c1/files/notes.md HTTP/1.1" 404' in missing


def test_console_hides_uvicorn_lifecycle_lines(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO", "console")

    server = logging.getLogger("uvicorn.error")
    server.info("Will watch for changes in these directories: %s", ["/srv/src"])
    server.info("Uvicorn running on %s://%s:%d (Press CTRL+C to quit)", "http", "localhost", 7788)
    server.info("Started reloader process [41] using WatchFiles")
    server.info("Started server process [%d]", 42)
    server.info("Waiting for application startup.")
    server.info("Application startup complete.")
    server.warning("%s detected changes in %s. Reloading...", "WatchFiles", "'src/app.py'")
    server.info("Shutting down")
    server.info("Waiting for application shutdown.")
    server.info("Application shutdown complete.")
    server.info("Finished server process [%d]", 42)
    server.info("Stopping reloader process [41]")

    running, ready, reloading = capsys.readouterr().err.splitlines()
    assert "Uvicorn running on http://localhost:7788" in running
    assert "Application startup complete." in ready
    assert "WatchFiles detected changes in 'src/app.py'. Reloading..." in reloading


def test_json_keeps_routine_access_and_lifecycle_lines(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("INFO", "json")

    _access("/conversations", 200)
    logging.getLogger("uvicorn.error").info("Waiting for application startup.")

    events = [json.loads(line)["event"] for line in capsys.readouterr().err.splitlines()]
    assert events == [
        '127.0.0.1:50000 - "GET /conversations HTTP/1.1" 200',
        "Waiting for application startup.",
    ]


@pytest.mark.parametrize("fmt", ["console", "json"])
def test_token_in_the_path_is_masked_in_both_formats(
    capsys: pytest.CaptureFixture[str], fmt: LogFormat
) -> None:
    configure_logging("INFO", fmt, token_path_prefixes=("/final-cut/preview",))

    _access("/final-cut/preview/ticket-1/files/index.html", 404)
    _access("/final-cut/preview/ticket-1", 404)
    _access("/conversations/c1/final-cut/preview", 200, "POST")

    lines = capsys.readouterr().err.splitlines()
    texts = [json.loads(line)["event"] for line in lines] if fmt == "json" else lines
    err = "\n".join(texts)
    assert "ticket-1" not in err
    assert '"GET /final-cut/preview/***/files/index.html HTTP/1.1" 404' in err
    assert '"GET /final-cut/preview/*** HTTP/1.1" 404' in err
    assert '"POST /conversations/c1/final-cut/preview HTTP/1.1" 200' in err


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
