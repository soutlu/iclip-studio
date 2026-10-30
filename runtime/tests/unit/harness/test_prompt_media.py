"""给模型的用户输入：图片一律带缩图像素，挂不上缩放参数的地址明确报错，不再只给地址。"""

from __future__ import annotations

import pytest
from pydantic_ai.messages import ImageUrl

from agent_runtime.errors import ValidationFailed
from agent_runtime.harness.transcript.prompt_media import model_prompt
from agent_runtime.transcript.ops import AttachmentSource, ImageContent, TextContent

pytestmark = pytest.mark.unit

OSS = "https://bkt.oss-ap-southeast-1.aliyuncs.com/iclip/agent/uploads/a.png"


def _image(url: str) -> ImageContent:
    return ImageContent(source=AttachmentSource(kind="url", url=url))


def test_an_oss_image_goes_in_with_its_thumbnail() -> None:
    prompt = model_prompt((TextContent(text="看这张"), _image(OSS)))

    assert prompt[0] == "看这张"
    assert prompt[1] == f'<image url="{OSS}">'
    assert prompt[2] == ImageUrl(url=f"{OSS}?x-oss-process=image/resize,l_1024")
    assert prompt[3] == "</image>"


@pytest.mark.parametrize(
    "url",
    [
        pytest.param("https://cdn.test/style.jpg", id="外部地址"),
        pytest.param(f"{OSS}?Signature=abc", id="带签名 query"),
    ],
)
def test_an_image_that_cannot_be_thumbnailed_is_an_error_naming_the_address(url: str) -> None:
    with pytest.raises(ValidationFailed, match="模型看不到这张图") as raised:
        model_prompt((TextContent(text="看这张"), _image(url)))

    assert url in str(raised.value)
