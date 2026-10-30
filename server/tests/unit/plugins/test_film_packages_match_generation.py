"""验证工程文件的包声明与生成域一致：上限与图片模型的画幅、分辨率。"""

from __future__ import annotations

from iclip_video.iclip_studio.film.packages import (
    GPT_IMAGE_ASPECTS,
    GPT_IMAGE_MODEL,
    GPT_IMAGE_RESOLUTIONS,
    IMAGE_MAX_REFERENCES,
    PROMPT_MAX_CHARS,
    VIDEO_MAX_REFERENCES,
)
from iclip_video.shot_rules import MAX_REFERENCE_IMAGES

from iclip.domains.generation import schemas as generation
from iclip.domains.generation.gpt_image import GPT_IMAGE_2_5


def test_package_limits_match_the_generation_domain() -> None:
    assert IMAGE_MAX_REFERENCES == generation.IMAGE_MAX_REFERENCES
    assert PROMPT_MAX_CHARS == generation.MAX_PROMPT_CHARS
    assert VIDEO_MAX_REFERENCES == MAX_REFERENCE_IMAGES


def test_the_image_package_offers_exactly_what_the_image_model_declares() -> None:
    """文件里能写的画幅和分辨率照生成域里这家模型的声明；这里不能引它，所以用这条测试钉住。"""

    assert GPT_IMAGE_2_5.name == GPT_IMAGE_MODEL
    assert set(GPT_IMAGE_ASPECTS) == set(GPT_IMAGE_2_5.spec.aspect_ratios)
    assert GPT_IMAGE_2_5.spec.resolutions == GPT_IMAGE_RESOLUTIONS
