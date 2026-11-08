from __future__ import annotations

from typing import Any, Final, get_args

from iclip.domains.generation.image_upstream import GatewayImageModel
from iclip.domains.generation.provider import ImageModelSpec, ProviderError
from iclip.domains.generation.schemas import (
    IMAGE_ASPECT_RATIOS,
    IMAGE_RESOLUTIONS,
    ImageGenerationIn,
)

_NAME: Final = "nano_banana_pro"


def _fields(request: ImageGenerationIn) -> dict[str, Any]:
    if request.channel is None:
        raise ProviderError(
            f"{_NAME} 的请求没有渠道",
            code="PROVIDER_CHANNEL_MISSING",
            retryable=False,
        )
    return {
        "aspect_ratio": request.aspect_ratio,
        "resolution": request.resolution,
        "channel": request.channel,
    }


NANO_BANANA_PRO: Final = GatewayImageModel(
    name=_NAME,
    spec=ImageModelSpec(
        label="Nano Banana Pro",
        aspect_ratios=get_args(IMAGE_ASPECT_RATIOS),
        resolutions=get_args(IMAGE_RESOLUTIONS),
        channels=("dev", "pro"),
    ),
    timeout_seconds=300.0,
    fields=_fields,
)


__all__ = ["NANO_BANANA_PRO"]
