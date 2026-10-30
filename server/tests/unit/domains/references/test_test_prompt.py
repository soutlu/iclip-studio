"""试生成提示词：从拆解里取哪几块、怎么排，秒数怎么取，缺了什么就拼不出。"""

from __future__ import annotations

import pytest
from agent_runtime.errors import ValidationFailed
from iclip_video.shot_prompt import parse_shot_prompt

from iclip.domains.references.test_prompt import build_test_prompt

ELEMENTS = """\
# 出场元素

| 类型 | 名字 | 辨识特征 | 首次出现 |
| :--- | :--- | :--- | :--- |
| 人物 | 金色短发女生 | 二十岁出头的白人女性。 | 0.0 |
| 产品 | 厚底毛口拖鞋 | 一双浅卡其色麂皮厚底拖鞋。 | 0.0 |
| 场景 | 滑板公园 | 城市里一座露天滑板公园。 | 2.4 |
"""

TIMELINE = """\
# 时间线

## 0.0-6.8 · 场景引入

### 镜 01 · 0.0-2.4

**镜头语言**：开场，手持，平视全景，缓慢推近
**画面**：金色短发女生站在涂鸦墙前。
**BGM**：一首轻快的吉他曲
**音效**：1.2 滑板轮子落地的咔哒声
**包装**：
- 0.4-2.0 画面左上角的白色大字：「周末」，从左侧滑入
- 1.0-2.4 画面中央的红色箭头
**关键帧**：0.4

### 镜 02 · 2.4–6.8

**镜头语言**：硬切，低机位，固定，脚部特写。
**画面**：她的右脚踩上滑板。
**BGM**：音乐继续
**音效**：无
**包装**：无
**关键帧**：3.0

## 6.8-9.25 · 品牌收尾

### 镜 03 · 6.8-9.25

**镜头语言**：硬切，固定，近景
**画面**：
- 她低头看鞋。
- 她抬头笑了一下。
**BGM**：音乐渐弱
**音效**：
- 7.0 一声口哨
- 8.1 风声
**包装**：无
**关键帧**：7.2
"""

ANALYSIS = """\
# 整片分析

## 想达到什么
记住这双拖鞋。
"""

DOCUMENT = f"{ELEMENTS}\n{TIMELINE}\n{ANALYSIS}"


def test_takes_elements_and_each_shots_lens_picture_and_sound() -> None:
    prompt = build_test_prompt(DOCUMENT)

    script = parse_shot_prompt(prompt.text)
    assert script is not None
    for detail in (
        "金色短发女生",
        "二十岁出头的白人女性。",
        "厚底毛口拖鞋",
        "一双浅卡其色麂皮厚底拖鞋。",
        "滑板公园",
        "城市里一座露天滑板公园。",
    ):
        assert detail in script.global_settings
    assert [shot.timestamps for shot in script.timeline] == [(0, 2.4), (2.4, 6.8), (6.8, 9.25)]
    for shot, details in zip(
        script.timeline,
        (
            (
                "开场，手持，平视全景，缓慢推近",
                "金色短发女生站在涂鸦墙前。",
                "1.2 滑板轮子落地的咔哒声",
            ),
            ("硬切，低机位，固定，脚部特写。", "她的右脚踩上滑板。"),
            ("硬切，固定，近景", "她低头看鞋。", "她抬头笑了一下。", "7.0 一声口哨", "8.1 风声"),
        ),
        strict=True,
    ):
        assert all(detail in shot.prompt for detail in details)
    for excluded in (
        "一首轻快的吉他曲",
        "音乐继续",
        "音乐渐弱",
        "白色大字",
        "红色箭头",
        "记住这双拖鞋。",
    ):
        assert excluded not in prompt.text


@pytest.mark.parametrize(("end", "seconds"), [("9.25", 10), ("9.0", 9)])
def test_seconds_round_the_last_shots_end_up(end: str, seconds: int) -> None:
    document = DOCUMENT.replace("6.8-9.25", f"6.8-{end}")
    assert build_test_prompt(document).seconds == seconds


@pytest.mark.parametrize(
    "document",
    [
        pytest.param(f"{TIMELINE}\n{ANALYSIS}", id="missing-elements"),
        pytest.param(
            "# 出场元素\n\n| 类型 | 名字 | 辨识特征 | 首次出现 |\n| :--- | :--- | :--- | :--- |\n"
            + TIMELINE,
            id="empty-elements",
        ),
        pytest.param(
            f"{ELEMENTS}\n# 时间线\n\n## 0.0-6.8 · 场景引入\n\n{ANALYSIS}", id="missing-shots"
        ),
        pytest.param(DOCUMENT.replace("**画面**：她的右脚踩上滑板。\n", ""), id="missing-picture"),
    ],
)
def test_incomplete_breakdowns_cannot_be_built(document: str) -> None:
    with pytest.raises(ValidationFailed):
        build_test_prompt(document)
