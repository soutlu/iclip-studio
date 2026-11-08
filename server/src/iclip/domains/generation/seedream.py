from __future__ import annotations

from typing import Any, Final, get_args

from iclip.domains.generation.image_upstream import GatewayImageModel
from iclip.domains.generation.provider import ImageModelSpec, ProviderError
from iclip.domains.generation.schemas import (
    IMAGE_ASPECT_RATIOS,
    IMAGE_RESOLUTIONS,
    ImageGenerationIn,
)

_NAME: Final = "seedream_v5_pro"

_SIZES: Final[dict[tuple[str, str], str]] = {
    ("1:1", "1k"): "1024*1024",
    ("1:1", "2k"): "2048*2048",
    ("3:2", "1k"): "1248*832",
    ("3:2", "2k"): "2496*1664",
    ("2:3", "1k"): "832*1248",
    ("2:3", "2k"): "1664*2496",
    ("3:4", "1k"): "864*1152",
    ("3:4", "2k"): "1776*2368",
    ("4:3", "1k"): "1152*864",
    ("4:3", "2k"): "2368*1776",
    ("9:16", "1k"): "800*1424",
    ("9:16", "2k"): "1584*2816",
    ("16:9", "1k"): "1424*800",
    ("16:9", "2k"): "2816*1584",
    ("21:9", "1k"): "1568*672",
    ("21:9", "2k"): "3136*1344",
}


def _declared[T](values: tuple[T, ...], index: int) -> tuple[T, ...]:
    present = {key[index] for key in _SIZES}
    return tuple(value for value in values if value in present)


_OUTPUT_FORMAT: Final = "jpeg"


def _fields(request: ImageGenerationIn) -> dict[str, Any]:
    size = _SIZES.get((request.aspect_ratio, request.resolution))
    if size is None:
        raise ProviderError(
            f"{_NAME} 没有 {request.aspect_ratio} × {request.resolution} 的尺寸",
            code="PROVIDER_SIZE_UNSUPPORTED",
            retryable=False,
        )
    return {"size": size, "output_format": _OUTPUT_FORMAT}


SEEDREAM_V5_PRO: Final = GatewayImageModel(
    name=_NAME,
    spec=ImageModelSpec(
        label="Seedream 5.0 Pro",
        aspect_ratios=_declared(get_args(IMAGE_ASPECT_RATIOS), 0),
        resolutions=_declared(get_args(IMAGE_RESOLUTIONS), 1),
        channels=(),
    ),
    timeout_seconds=600.0,
    fields=_fields,
)


__all__ = ["SEEDREAM_V5_PRO"]
