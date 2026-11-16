from __future__ import annotations

import contextlib
import json
from typing import Any

import httpx
import pytest
from structlog.testing import capture_logs

from iclip.app.final_cut_translation import (
    LANGUAGE_NAMES,
    TRANSLATE_MAX_OUTPUT_TOKENS,
    TRANSLATE_MODEL,
    TRANSLATE_REASONING_EFFORT,
    TRANSLATE_TIMEOUT_SECONDS,
    build_translation_request,
    parse_translation_answer,
)
from iclip.common.errors import ModelUnavailable
from iclip.domains.conversations.final_cut_translation import (
    FinalCutText,
    FinalCutTranslationFailed,
    TargetLocale,
)
from tests.helpers.references import FakeArk, ark_translator, model_unavailable, responses_body

ENTRIES = (
    FinalCutText(id="t1", text="这双鞋只要 199 元"),
    FinalCutText(id="t2", text="第一行\n第二行 #轻跑"),
    FinalCutText(id="t3", text="Nike Air"),
)


def answer(*pairs: tuple[str, str], **extra: Any) -> str:
    return json.dumps({"translations": [{"id": key, "text": text} for key, text in pairs], **extra})


def ark_answer(raw: str, *, status: str = "completed") -> httpx.Response:
    return httpx.Response(200, json=responses_body(raw, status=status))


@pytest.mark.parametrize("locale", ["en", "de", "es", "fr"])
def test_the_system_prompt_names_the_target_language(locale: TargetLocale) -> None:
    request = build_translation_request(ENTRIES, locale)

    assert LANGUAGE_NAMES[locale] in request.system_prompt
    others = [name for key, name in LANGUAGE_NAMES.items() if key != locale]
    assert not any(name in request.system_prompt for name in others)


def test_the_request_carries_every_entry_with_its_newlines_and_limits_answer_ids() -> None:
    request = build_translation_request(ENTRIES, "en")

    assert json.loads(request.user_text) == {
        "entries": [{"id": one.id, "text": one.text} for one in ENTRIES]
    }
    assert "第一行\\n第二行" in request.user_text, "中文原样发，不转义成 \\u；换行按 JSON 写作 \\n"
    fmt = request.text_format
    assert (fmt["type"], fmt["strict"]) == ("json_schema", True)
    item = fmt["schema"]["properties"]["translations"]["items"]
    assert item["properties"]["id"]["enum"] == ["t1", "t2", "t3"]
    assert item["required"] == ["id", "text"]


def test_answers_come_back_in_request_order_whatever_order_the_model_used() -> None:
    raw = answer(("t3", "Nike Air"), ("t1", "Only 199 yuan"), ("t2", "Line one\nLine two #轻跑"))

    assert parse_translation_answer(raw, ENTRIES) == (
        FinalCutText(id="t1", text="Only 199 yuan"),
        FinalCutText(id="t2", text="Line one\nLine two #轻跑"),
        FinalCutText(id="t3", text="Nike Air"),
    )


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        pytest.param(answer(("t1", "a"), ("t2", "b")), "缺了 id 't3'", id="missing"),
        pytest.param(
            answer(("t1", "a"), ("t2", "b"), ("t3", "c"), ("t4", "d")),
            "多出了请求里没有的 id 't4'",
            id="extra",
        ),
        pytest.param(
            answer(("t1", "a"), ("t2", "b"), ("t9", "c")),
            "多出了请求里没有的 id 't9'",
            id="id-mismatch",
        ),
        pytest.param(
            answer(("t1", "a"), ("t1", "a"), ("t2", "b"), ("t3", "c")),
            "id 't1' 出现了不止一次",
            id="duplicate",
        ),
        pytest.param(answer(("t1", "a"), ("t2", ""), ("t3", "c")), "'t2' 的译文是空的", id="empty"),
        pytest.param(
            answer(("t1", "a"), ("t2", "  \n"), ("t3", "c")), "'t2' 的译文是空的", id="blank"
        ),
        pytest.param("Here you go: t1=a", "不是 JSON", id="not-json"),
        pytest.param(json.dumps([{"id": "t1", "text": "a"}]), "结构不对", id="top-level-array"),
        pytest.param(answer(("t1", "a"), note="x"), "结构不对", id="extra-key"),
        pytest.param(json.dumps({"translations": {"t1": "a"}}), "结构不对", id="not-a-list"),
        pytest.param(json.dumps({"translations": [{"id": "t1"}]}), "结构不对", id="item-fields"),
        pytest.param(
            json.dumps({"translations": [{"id": 1, "text": "a"}]}), "结构不对", id="int-id"
        ),
    ],
)
def test_unusable_answers_fail_without_falling_back_to_the_source(raw: str, reason: str) -> None:
    with pytest.raises(FinalCutTranslationFailed) as caught:
        parse_translation_answer(raw, ENTRIES)

    assert caught.value.code == "model_failed"
    assert reason in str(caught.value)


async def test_the_call_goes_to_the_translation_model_with_the_built_request() -> None:
    ark = FakeArk(tag=ark_answer(answer(("t2", "B"), ("t1", "A"), ("t3", "Nike Air"))))

    translated = await ark_translator(ark).translate(ENTRIES, locale="es")

    assert [one.id for one in translated] == ["t1", "t2", "t3"]
    assert [one.text for one in translated] == ["A", "B", "Nike Air"]
    (call,) = ark.calls
    assert (call["declaration"], call["model"]) == ("volcengine", TRANSLATE_MODEL)
    assert call["read_timeout"] == TRANSLATE_TIMEOUT_SECONDS
    sent = call["payload"]
    expected = build_translation_request(ENTRIES, "es")
    system, user = sent["input"]
    assert system["content"] == [{"type": "input_text", "text": expected.system_prompt}]
    assert "西班牙语" in expected.system_prompt
    assert user["content"] == [{"type": "input_text", "text": expected.user_text}]
    assert sent["text"] == {"format": expected.text_format}
    assert sent["reasoning"] == {"effort": TRANSLATE_REASONING_EFFORT}
    assert sent["max_output_tokens"] == TRANSLATE_MAX_OUTPUT_TOKENS


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        pytest.param(httpx.Response(503, text="busy"), "model_call_failed", id="5xx"),
        pytest.param(httpx.Response(429, text="slow down"), "model_call_failed", id="429"),
        pytest.param(httpx.ConnectError("refused"), "model_call_failed", id="unreachable"),
        pytest.param(ark_answer("", status="incomplete"), "model_call_failed", id="incomplete"),
        pytest.param(httpx.Response(400, text="rejected"), "model_failed", id="rejected"),
        pytest.param(ark_answer("不是 JSON"), "model_failed", id="bad-answer"),
    ],
)
async def test_call_failures_split_by_whether_another_try_may_help(
    reply: httpx.Response | Exception, code: str
) -> None:
    with pytest.raises(FinalCutTranslationFailed) as caught:
        await ark_translator(FakeArk(tag=reply)).translate(ENTRIES, locale="en")

    assert caught.value.code == code
    assert "busy" not in str(caught.value) and "rejected" not in str(caught.value), (
        "上游答复的原文不往外给"
    )


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param(ark_answer(answer(("t1", "UNO"), ("t2", "DOS"), ("t3", "TRES"))), id="done"),
        pytest.param(ark_answer(answer(("t1", "UNO"), ("t2", "DOS"))), id="failed"),
    ],
)
async def test_logs_carry_counts_and_codes_but_never_the_texts(reply: httpx.Response) -> None:
    with capture_logs() as logs, contextlib.suppress(FinalCutTranslationFailed):
        await ark_translator(FakeArk(tag=reply)).translate(ENTRIES, locale="es")

    (event,) = [one for one in logs if str(one["event"]).startswith("final-cut 翻译")]
    assert (event["locale"], event["count"]) == ("es", 3)
    dumped = repr(logs)
    for text in (*(one.text for one in ENTRIES), "UNO", "DOS", "TRES"):
        assert text not in dumped


async def test_a_model_that_is_not_enabled_is_reported_as_unavailable() -> None:
    with pytest.raises(ModelUnavailable) as caught:
        await ark_translator(FakeArk(tag=model_unavailable())).translate(ENTRIES, locale="fr")

    assert caught.value.code == "model_unavailable"
