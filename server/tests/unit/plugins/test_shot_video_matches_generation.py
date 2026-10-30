"""验证取帧与出图插件钉死的图片模型与生成域一致：这家模型给得了出图要的分辨率、画幅与渠道。"""

from __future__ import annotations

from typing import get_args

from iclip_video.shot_video.generation import ANCHOR_ASPECT, GRID_RESOLUTION, IMAGE_MODEL
from iclip_video.shot_video.ports import ImageChannel

from iclip.domains.generation.module import IMAGE_MODEL_SPECS


def test_the_pinned_image_model_can_do_what_the_frame_tools_ask_for() -> None:
    """出图把用哪家、多大、哪个渠道都钉在代码里，模型面签名里没有这些参数。

    钉的那家给不了其中任何一样，就是每次出图都拿到一个模型改不了的错误。这些全是代码
    里的常量，所以在这里拦，不等部署。"""

    spec = IMAGE_MODEL_SPECS.get(IMAGE_MODEL)
    assert spec is not None, f"{IMAGE_MODEL} 没有对应的适配器"
    assert GRID_RESOLUTION in spec.resolutions
    assert ANCHOR_ASPECT in spec.aspect_ratios
    assert set(get_args(ImageChannel)) <= set(spec.channels)
