"""识别响应映射成逐句字幕：几句、空、缺字段、说话人编号与 null、逐词时间，形状不对明确报错；
落库形状与读回。"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from iclip.domains.generation.models import GenerationOutput
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import SubtitleSentence, SubtitleWord
from iclip.domains.generation.subtitles import sentences_from_response


def _body(sentences: Any = None, *, omit: bool = False) -> dict[str, Any]:
    """照同步识别接口开说话人分离时的非流式响应：``output.sentence`` 是最后一句，``output.sentences``
    是全部句子。"""

    output: dict[str, Any] = {"text": "整段文字"}
    if not omit:
        output["sentences"] = sentences
    return {"output": output, "usage": {"duration": 4}, "request_id": "req-1"}


def _word(begin: int, end: int, text: str, punctuation: str = "") -> dict[str, Any]:
    return {
        "begin_time": begin,
        "end_time": end,
        "text": text,
        "punctuation": punctuation,
        "fixed": False,
        "speaker_id": 0,
    }


def _sentence(
    begin: int, end: int, text: str, speaker: Any = 0, words: Any = None
) -> dict[str, Any]:
    return {
        "begin_time": begin,
        "end_time": end,
        "text": text,
        "speaker_id": speaker,
        "sentence_id": 1,
        "sentence_end": True,
        "channel_id": 0,
        "words": [_word(begin, end, text)] if words is None else words,
    }


def test_words_keep_their_times_text_and_following_punctuation_in_order() -> None:
    words = [
        _word(0, 215, "秋"),
        _word(215, 645, "天来"),
        _word(645, 1075, "了", "，"),
        _word(1075, 1505, "我们"),
        _word(1505, 3440, "一起去公园散步吧", "。"),
    ]
    body = _body([_sentence(0, 3440, "秋天来了，我们一起去公园散步吧。", words=words)])

    (sentence,) = sentences_from_response(body)

    assert sentence.text == "秋天来了，我们一起去公园散步吧。"
    assert sentence.words == (
        SubtitleWord(start_ms=0, end_ms=215, text="秋", punctuation=""),
        SubtitleWord(start_ms=215, end_ms=645, text="天来", punctuation=""),
        SubtitleWord(start_ms=645, end_ms=1075, text="了", punctuation="，"),
        SubtitleWord(start_ms=1075, end_ms=1505, text="我们", punctuation=""),
        SubtitleWord(start_ms=1505, end_ms=3440, text="一起去公园散步吧", punctuation="。"),
    )


def test_a_word_that_omits_the_punctuation_key_has_none_after_it() -> None:
    word = _word(0, 300, "好")
    del word["punctuation"]

    (sentence,) = sentences_from_response(_body([_sentence(0, 300, "好", words=[word])]))
    assert sentence.words == (SubtitleWord(start_ms=0, end_ms=300, text="好", punctuation=""),)


def test_a_sentence_that_omits_the_words_key_has_no_words() -> None:
    item = _sentence(0, 900, "嗯。")
    del item["words"]

    (sentence,) = sentences_from_response(_body([item]))
    assert sentence.words == ()


def test_a_sentence_with_null_words_has_no_words() -> None:
    item = _sentence(0, 900, "嗯。") | {"words": None}

    (sentence,) = sentences_from_response(_body([item]))
    assert sentence.words == ()


def test_a_sentence_without_a_speaker_number_keeps_null() -> None:
    body = _body([_sentence(0, 900, "嗯。", speaker=None)])

    (sentence,) = sentences_from_response(body)
    assert sentence.speaker is None


def test_a_sentence_that_omits_the_speaker_key_keeps_null() -> None:
    item = _sentence(0, 900, "嗯。")
    del item["speaker_id"]

    (sentence,) = sentences_from_response(_body([item]))
    assert sentence.speaker is None


def test_a_stored_sentence_from_before_word_timing_reads_back_without_words() -> None:
    payload = [{"start_ms": 0, "end_ms": 900, "text": "好", "speaker": 0}]

    assert GenerationOutput.model_validate({"sentences": payload}).sentences == (
        SubtitleSentence(start_ms=0, end_ms=900, text="好", speaker=0, words=()),
    )


def test_a_stored_word_with_reversed_times_is_refused() -> None:
    payload = [
        {
            "start_ms": 0,
            "end_ms": 900,
            "text": "好",
            "speaker": 0,
            "words": [{"start_ms": 500, "end_ms": 100, "text": "好", "punctuation": ""}],
        }
    ]

    with pytest.raises(ValidationError, match="end_ms 不能早于 start_ms"):
        GenerationOutput.model_validate({"sentences": payload})


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"request_id": "req-1"}, "没有 output"),
        (_body(None), "不是数组"),
        (_body(omit=True), "不是数组"),
        (_body("不是数组"), "不是数组"),
        (_body(["不是对象"]), "不是对象"),
        (_body([{"begin_time": 0, "text": "缺结尾"}]), "begin_time / end_time / text"),
        (_body([_sentence(0, 100, "x") | {"text": None}]), "begin_time / end_time / text"),
        (_body([_sentence(0, 100, "x") | {"begin_time": True}]), "begin_time / end_time / text"),
        (_body([_sentence(0, 100, "x", speaker="甲")]), "speaker_id 不是整数"),
        (_body([_sentence(500, 100, "倒着", words=[])]), r"output\.sentences\[0\] 的时间不合法"),
    ],
)
def test_a_malformed_response_is_an_explicit_failure(body: dict[str, Any], fragment: str) -> None:
    with pytest.raises(ProviderError, match=fragment) as raised:
        sentences_from_response(body)
    assert raised.value.code == "PROVIDER_MALFORMED"
    assert raised.value.retryable is False


@pytest.mark.parametrize(
    ("words", "fragment"),
    [
        ("不是数组", r"output\.sentences\[1\]\.words 不是数组"),
        ({"text": "x"}, r"output\.sentences\[1\]\.words 不是数组"),
        ([_word(0, 50, "a"), "不是对象"], r"output\.sentences\[1\]\.words\[1\] 不是对象"),
        ([{"begin_time": 0, "text": "缺结尾"}], r"words\[0\] 缺 begin_time / end_time / text"),
        ([_word(0, 50, "a") | {"begin_time": True}], r"words\[0\] 缺 begin_time"),
        ([_word(0, 50, "a") | {"end_time": "50"}], r"words\[0\] 缺 begin_time"),
        ([_word(0, 50, "a") | {"text": None}], r"words\[0\] 缺 begin_time"),
        ([_word(0, 50, "a") | {"punctuation": None}], r"words\[0\]\.punctuation 不是字符串"),
        ([_word(0, 50, "a") | {"punctuation": 1}], r"words\[0\]\.punctuation 不是字符串"),
        ([_word(50, 0, "倒着")], r"words\[0\] 的时间不合法"),
        ([_word(-10, 0, "负的")], r"words\[0\] 的时间不合法"),
    ],
)
def test_malformed_words_are_an_explicit_failure(words: Any, fragment: str) -> None:
    body = _body([_sentence(0, 100, "x"), _sentence(200, 300, "y", words=words)])

    with pytest.raises(ProviderError, match=fragment) as raised:
        sentences_from_response(body)
    assert raised.value.code == "PROVIDER_MALFORMED"
    assert raised.value.retryable is False
