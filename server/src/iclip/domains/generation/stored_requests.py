from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, Final

from pydantic import Discriminator, Tag, TypeAdapter

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.film_schemas import WholeFilmRequest
from iclip.domains.generation.schemas import (
    KIND_AUDIO,
    KIND_IMAGE,
    KIND_SUBTITLE,
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_GENERATE,
    OPERATION_UPLOAD,
    READ_BACK_CONTEXT,
    ImageGenerationIn,
    MusicRequest,
    SubtitleRequest,
    VideoComposeRequest,
    VideoGenerationIn,
)

GenerationRequest = (
    VideoGenerationIn
    | ImageGenerationIn
    | VideoComposeRequest
    | WholeFilmRequest
    | SubtitleRequest
    | MusicRequest
)


def _compose_shape(value: Any) -> str:
    if isinstance(value, WholeFilmRequest) or (isinstance(value, dict) and "render" in value):
        return "whole_film"
    return "composite"


ComposeRequest = Annotated[
    Annotated[VideoComposeRequest, Tag("composite")]
    | Annotated[WholeFilmRequest, Tag("whole_film")],
    Discriminator(_compose_shape),
]

_ADAPTERS: Final[Mapping[tuple[str, str], TypeAdapter[Any]]] = {
    (KIND_VIDEO, OPERATION_GENERATE): TypeAdapter(VideoGenerationIn),
    (KIND_IMAGE, OPERATION_GENERATE): TypeAdapter(ImageGenerationIn),
    (KIND_VIDEO, OPERATION_COMPOSE): TypeAdapter(ComposeRequest),
    (KIND_SUBTITLE, OPERATION_GENERATE): TypeAdapter(SubtitleRequest),
    (KIND_AUDIO, OPERATION_GENERATE): TypeAdapter(MusicRequest),
}

_WITHOUT_REQUEST: Final = frozenset(
    {
        (KIND_IMAGE, OPERATION_CUT),
        (KIND_IMAGE, OPERATION_UPLOAD),
        (KIND_VIDEO, OPERATION_UPLOAD),
        (KIND_AUDIO, OPERATION_UPLOAD),
    }
)


def request_from_payload(
    kind: str, operation: str, payload: dict[str, Any] | None
) -> GenerationRequest | None:
    if (kind, operation) in _WITHOUT_REQUEST:
        if payload is not None:
            raise ValidationFailed(f"{kind} / {operation} 不该带请求")
        return None
    adapter = _ADAPTERS.get((kind, operation))
    if adapter is None:
        raise ValidationFailed(f"未知的生成类型: {kind} / {operation}")
    if payload is None:
        raise ValidationFailed(f"{kind} / {operation} 的生成请求缺失")
    try:
        return adapter.validate_python(payload, context={READ_BACK_CONTEXT: True})
    except ValueError as exc:
        raise ValidationFailed(f"生成请求的形状不合法: {exc}") from exc


__all__ = ["ComposeRequest", "GenerationRequest", "request_from_payload"]
