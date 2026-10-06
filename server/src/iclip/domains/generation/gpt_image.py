"""GPT Image 2.5 在网关上与别家不同的部分：收像素 ``size``，质量档固定用 auto，没有渠道。

它的两条任务路由与别家不同名，由配置里这一家自己的 ``text_to_image_task`` 与 ``image_edit_task``
给出。提交、读结果地址与转存由 image_upstream.py 的网关 provider 统一处理。"""

from __future__ import annotations

from typing import Any, Final, get_args

from iclip.domains.generation.image_upstream import GatewayImageModel
from iclip.domains.generation.provider import ImageModelSpec, ProviderError
from iclip.domains.generation.schemas import IMAGE_ASPECT_RATIOS, ImageGenerationIn

_NAME: Final = "gpt-image-2.5"

_RESOLUTION: Final = "2k"
"""现在只开放这一档。"""

_SIZES: Final[dict[str, str]] = {
    "1:1": "2048x2048",
    "3:2": "2016x1344",
    "2:3": "1344x2016",
    "3:4": "1536x2048",
    "4:3": "2048x1536",
    "4:5": "1600x2000",
    "5:4": "2000x1600",
    "9:16": "1152x2048",
    "16:9": "2048x1152",
    "21:9": "2560x1088",
}
"""画幅 → 2k 一档发给上游的 ``宽x高``。上游要求宽高都是 16 的倍数、画幅在 1:3 到 3:1 之间。"""

_QUALITY: Final = "auto"
"""质量档不由调用方选。上游不传时按 medium 出图，所以这里明确传 auto。"""


def _fields(request: ImageGenerationIn) -> dict[str, Any]:
    """把画幅翻成上游的像素 size。"""

    size = _SIZES.get(request.aspect_ratio) if request.resolution == _RESOLUTION else None
    if size is None:
        # 受理层照能力声明拦过，走到这里说明声明与映射表不一致。
        raise ProviderError(
            f"{_NAME} 没有 {request.aspect_ratio} × {request.resolution} 的尺寸",
            code="PROVIDER_SIZE_UNSUPPORTED",
            retryable=False,
        )
    return {"size": size, "quality": _QUALITY}


GPT_IMAGE_2_5: Final = GatewayImageModel(
    name=_NAME,
    spec=ImageModelSpec(
        label="GPT Image 2.5",
        aspect_ratios=tuple(ratio for ratio in get_args(IMAGE_ASPECT_RATIOS) if ratio in _SIZES),
        resolutions=(_RESOLUTION,),
        channels=(),
    ),
    # 与 Seedream 一样给足十分钟：2k 出图慢，它自己一条队列，占着不影响别家。
    timeout_seconds=600.0,
    fields=_fields,
)


__all__ = ["GPT_IMAGE_2_5"]
