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
    VideoEditRequest,
    VideoEnhanceRequest,
    VideoGenerationIn,
    WholeFilmRequest,
)

GenerationRequest = (
    VideoGenerationIn
    | VideoEditRequest
    | ImageGenerationIn
    | VideoComposeRequest
    | SubtitleRequest
    | MusicRequest
    | WholeFilmRequest
    | VideoEnhanceRequest
)

_ADAPTERS: Final[Mapping[tuple[str, str], TypeAdapter[Any]]] = {
    (KIND_VIDEO, OPERATION_GENERATE): TypeAdapter(VideoGenerationIn),
    (KIND_IMAGE, OPERATION_GENERATE): TypeAdapter(ImageGenerationIn),
    (KIND_VIDEO, OPERATION_COMPOSE): TypeAdapter(VideoComposeRequest),
    (KIND_SUBTITLE, OPERATION_GENERATE): TypeAdapter(SubtitleRequest),
    (KIND_AUDIO, OPERATION_GENERATE): TypeAdapter(MusicRequest),
    (KIND_WHOLE_FILM, OPERATION_RENDER): TypeAdapter(WholeFilmRequest),
    (KIND_VIDEO, OPERATION_ENHANCE): TypeAdapter(VideoEnhanceRequest),
}

_EDIT: Final[TypeAdapter[Any]] = TypeAdapter(VideoEditRequest)

_WITHOUT_REQUEST: Final = frozenset(
    {
        (KIND_IMAGE, OPERATION_CUT),
        (KIND_IMAGE, OPERATION_UPLOAD),
        (KIND_VIDEO, OPERATION_UPLOAD),
        (KIND_AUDIO, OPERATION_UPLOAD),
    }
)


def request_from_payload(
    kind: str, operation: str, payload: dict[str, Any] | None, *, has_source: bool
) -> GenerationRequest | None:
    """按种类、操作与有没有来源读回请求快照：有来源的视频 generate 是编辑段，其余只看前两者。"""

    if (kind, operation) in _WITHOUT_REQUEST:
        if payload is not None:
            raise ValidationFailed(f"{kind} / {operation} 不该带请求")
        return None
    if (kind, operation) == (KIND_VIDEO, OPERATION_GENERATE) and has_source:
        adapter = _EDIT
    else:
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
