from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from pydantic import TypeAdapter

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    KIND_AUDIO,
    KIND_IMAGE,
    KIND_SUBTITLE,
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_ENHANCE,
    OPERATION_GENERATE,
    OPERATION_RENDER,
    OPERATION_UPLOAD,
    READ_BACK_CONTEXT,
    ImageGenerationIn,
    MusicRequest,
    SubtitleRequest,
    VideoComposeRequest,
    VideoEnhanceRequest,
    VideoGenerationIn,
    WholeFilmRequest,
)

GenerationRequest = (
    VideoGenerationIn
    | ImageGenerationIn
    | VideoComposeRequest
    | SubtitleRequest
    | MusicRequest
    | WholeFilmRequest
    | VideoEnhanceRequest
)

_ENHANCE: Final = TypeAdapter(VideoEnhanceRequest)

_ADAPTERS: Final[Mapping[tuple[str, str], TypeAdapter[Any]]] = {
    (KIND_VIDEO, OPERATION_GENERATE): TypeAdapter(VideoGenerationIn),
    (KIND_IMAGE, OPERATION_GENERATE): TypeAdapter(ImageGenerationIn),
    (KIND_VIDEO, OPERATION_COMPOSE): TypeAdapter(VideoComposeRequest),
    (KIND_SUBTITLE, OPERATION_GENERATE): TypeAdapter(SubtitleRequest),
    (KIND_AUDIO, OPERATION_GENERATE): TypeAdapter(MusicRequest),
    (KIND_WHOLE_FILM, OPERATION_RENDER): TypeAdapter(WholeFilmRequest),
    # 超分记录的种类跟来源走，两种来源是同一个请求。
    (KIND_VIDEO, OPERATION_ENHANCE): _ENHANCE,
    (KIND_WHOLE_FILM, OPERATION_ENHANCE): _ENHANCE,
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


__all__ = ["GenerationRequest", "request_from_payload"]
