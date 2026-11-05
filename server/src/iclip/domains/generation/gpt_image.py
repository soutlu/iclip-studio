from __future__ import annotations

from typing import Any, Final, get_args

from iclip.domains.generation.image_upstream import GatewayImageModel
from iclip.domains.generation.provider import ImageModelSpec, ProviderError
from iclip.domains.generation.schemas import IMAGE_ASPECT_RATIOS, ImageGenerationIn

_NAME: Final = "gpt-image-2.5"

_RESOLUTION: Final = "2k"

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

_QUALITY: Final = "auto"


def _fields(request: ImageGenerationIn) -> dict[str, Any]:
    size = _SIZES.get(request.aspect_ratio) if request.resolution == _RESOLUTION else None
    if size is None:
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
    timeout_seconds=600.0,
    fields=_fields,
)


__all__ = ["GPT_IMAGE_2_5"]
