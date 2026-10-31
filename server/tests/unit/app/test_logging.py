"""后端自己的日志配置：服务名、被压低的第三方 logger 与请求上下文。渲染链本身由运行时的测试负责。"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

import pytest
import structlog

from iclip.app.logging import QUIET_LOGGERS, configure_logging


@pytest.fixture
def restore_logging() -> Iterator[None]:
    """恢复 root handler，避免 configure_logging 影响 pytest 日志捕获。"""

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


def test_json_lines_carry_request_context_and_drop_procrastinate_info(
    capsys: pytest.CaptureFixture[str], restore_logging: None
) -> None:
    configure_logging("INFO", "json")
    structlog.contextvars.bind_contextvars(request_id="req-1")

    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d', "127.0.0.1", "GET", "/x", "1.1", 200
    )
    structlog.stdlib.get_logger("iclip.test").warning("捡回中断的生成任务", count=2)
    logging.getLogger("procrastinate.worker").info("Starting job")
    logging.getLogger("procrastinate.worker").warning("Job failed")

    lines = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert [(line["logger"], line["event"]) for line in lines] == [
        ("uvicorn.access", '127.0.0.1 - "GET /x HTTP/1.1" 200'),
        ("iclip.test", "捡回中断的生成任务"),
        ("procrastinate.worker", "Job failed"),
    ]
    access, ours, _ = lines
    assert access["request_id"] == "req-1"
    assert ours["request_id"] == "req-1"
    assert ours["count"] == 2


def test_console_line_names_the_backend(
    capsys: pytest.CaptureFixture[str], restore_logging: None
) -> None:
    configure_logging("INFO", "console")

    structlog.stdlib.get_logger("iclip.test").info("生成任务提交失败", job_id="j1")

    (line,) = capsys.readouterr().err.splitlines()
    assert line[9:].startswith("后端   [info")
    assert "生成任务提交失败 [iclip.test] job_id=j1" in line
