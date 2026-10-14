"""识别响应映射成逐句字幕：几句、空、缺字段、说话人编号与 null，形状不对明确报错。"""

from __future__ import annotations

from typing import Any

import pytest

from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import SubtitleSentence
from iclip.domains.generation.subtitles import sentences_from_response


def _body(sentences: Any = None, *, omit: bool = False) -> dict[str, Any]:
    """照同步识别接口开说话人分离时的非流式响应：``output.sentence`` 是最后一句，``output.sentences``
    是全部句子。"""

    output: dict[str, Any] = {"text": "整段文字"}
    if not omit:
        output["sentences"] = sentences
    return {"output": output, "usage": {"duration": 4}, "request_id": "req-1"}


def _sentence(begin: int, end: int, text: str, speaker: Any = 0) -> dict[str, Any]:
    return {
        "begin_time": begin,
        "end_time": end,
        "text": text,
        "speaker_id": speaker,
        "sentence_id": 1,
        "sentence_end": True,
        "channel_id": 0,
        "words": [{"begin_time": begin, "end_time": end, "text": text, "punctuation": ""}],
    }


def test_each_sentence_keeps_its_times_text_and_speaker_in_order() -> None:
    body = _body(
        [
            _sentence(760, 3800, "这双凉鞋很轻。", speaker=0),
            _sentence(4100, 6020, "Hello world.", speaker=1),
            _sentence(6500, 7000, "对。", speaker=0),
        ]
    )

    assert sentences_from_response(body) == (
        SubtitleSentence(start_ms=760, end_ms=3800, text="这双凉鞋很轻。", speaker=0),
        SubtitleSentence(start_ms=4100, end_ms=6020, text="Hello world.", speaker=1),
        SubtitleSentence(start_ms=6500, end_ms=7000, text="对。", speaker=0),
    )


def test_a_sentence_without_a_speaker_number_keeps_null() -> None:
    body = _body([_sentence(0, 900, "嗯。", speaker=None)])

    (sentence,) = sentences_from_response(body)
    assert sentence.speaker is None


def test_a_sentence_that_omits_the_speaker_key_keeps_null() -> None:
    item = _sentence(0, 900, "嗯。")
    del item["speaker_id"]

    (sentence,) = sentences_from_response(_body([item]))
    assert sentence.speaker is None


@pytest.mark.parametrize("body", [_body([]), _body(None), _body(omit=True)])
def test_no_sentences_means_no_voice_over(body: dict[str, Any]) -> None:
    assert sentences_from_response(body) == ()


def test_sentences_are_stored_with_snake_case_keys_and_read_out_in_camel_case() -> None:
    sentence = SubtitleSentence(start_ms=1, end_ms=2, text="好", speaker=None)

    assert sentence.model_dump() == {"start_ms": 1, "end_ms": 2, "text": "好", "speaker": None}
    assert sentence.model_dump(by_alias=True) == {
        "startMs": 1,
        "endMs": 2,
        "text": "好",
        "speaker": None,
    }


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"request_id": "req-1"}, "没有 output"),
        (_body("不是数组"), "不是数组"),
        (_body(["不是对象"]), "不是对象"),
        (_body([{"begin_time": 0, "text": "缺结尾"}]), "begin_time / end_time / text"),
        (_body([_sentence(0, 100, "x") | {"text": None}]), "begin_time / end_time / text"),
        (_body([_sentence(0, 100, "x") | {"begin_time": True}]), "begin_time / end_time / text"),
        (_body([_sentence(0, 100, "x", speaker="甲")]), "speaker_id 不是整数"),
        (_body([_sentence(500, 100, "倒着")]), "时间不合法"),
    ],
)
def test_a_malformed_response_is_an_explicit_failure(body: dict[str, Any], fragment: str) -> None:
    with pytest.raises(ProviderError, match=fragment) as raised:
        sentences_from_response(body)
    assert raised.value.code == "PROVIDER_MALFORMED"
    assert raised.value.retryable is False
