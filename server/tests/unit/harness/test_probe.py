"""试连的失败原因：按错误类别给一句话，只取上游错误体里的说明，抹掉机密；建不出模型也是结果。"""

from __future__ import annotations

import pytest
from pydantic_ai.exceptions import (
    ModelAuthenticationError,
    ModelConnectionError,
    ModelHTTPError,
    ModelTimeoutError,
)
from pydantic_ai.models.test import TestModel

from iclip.harness.probe import describe_failure, probe_model

SECRET = "sk-live-aaaaaaaaaaaaaaaa"


class AuthHTTPError(ModelHTTPError, ModelAuthenticationError):
    """上游答 401 时适配器抛的组合类型。"""


def test_authentication_failure_keeps_status_and_upstream_message_only() -> None:
    error = AuthHTTPError(
        401,
        "qwen3.8-flash",
        {"error": {"message": "Incorrect API key provided."}},
    )

    reason = describe_failure(error, timeout_seconds=15)

    assert reason == "API Key 无效或没有权限（HTTP 401）：Incorrect API key provided."
    assert "qwen3.8-flash" not in reason


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (ModelTimeoutError("m", "timed out"), "15 秒内没有答复"),
        (TimeoutError(), "15 秒内没有答复"),
        (ModelConnectionError("m", "connect failed"), "连不上接口地址"),
        (ModelHTTPError(500, "m", "oops"), "接口调用失败（HTTP 500）"),
        (ValueError("boom"), "试连出错（ValueError）"),
    ],
)
def test_failures_map_to_one_sentence_by_category(error: Exception, reason: str) -> None:
    assert describe_failure(error, timeout_seconds=15) == reason


async def test_secrets_echoed_by_the_upstream_are_scrubbed() -> None:
    def build() -> TestModel:
        raise RuntimeError(f"provider rejected key {SECRET}")

    outcome = await probe_model(build, label="acme/m1", secrets=[SECRET])

    assert outcome.ok is False
    assert outcome.reason is not None
    assert SECRET not in outcome.reason
    assert "按声明建不出模型" in outcome.reason


async def test_a_model_that_answers_passes() -> None:
    outcome = await probe_model(TestModel, label="acme/m1", secrets=[SECRET])

    assert outcome.ok is True
    assert outcome.reason is None
    assert outcome.elapsed_ms >= 0
