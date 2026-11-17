from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from pydantic import TypeAdapter

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.schemas import (
    KIND_AUDIO,
    KIND_DUBBING,
    KIND_IMAGE,
    KIND_SPEECH,
    KIND_SUBTITLE,
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_COMPOSE,
    OPERATION_CUT,
    OPERATION_ENHANCE,
    OPERATION_GENERATE,
    OPERATION_RENDER,
    OPERATION_TRIAL,
    READ_BACK_CONTEXT,
    DubbingRequest,
    ImageGenerationIn,
    MusicRequest,
    SpeechRequest,
    SubtitleRequest,
    VideoComposeRequest,
    VideoEditRequest,
    VideoEnhanceRequest,
    VideoGenerationIn,
    VideoTrialRequest,
    WholeFilmRequest,
)

GenerationRequest = (
    VideoGenerationIn
    | VideoTrialRequest
    | VideoEditRequest
    | ImageGenerationIn
    | VideoComposeRequest
    | SubtitleRequest
    | DubbingRequest
    | SpeechRequest
    | MusicRequest
    | WholeFilmRequest
    | VideoEnhanceRequest
)

_ADAPTERS: Final[Mapping[tuple[str, str], TypeAdapter[Any]]] = {
    (KIND_VIDEO, OPERATION_GENERATE): TypeAdapter(VideoGenerationIn),
    (KIND_VIDEO, OPERATION_TRIAL): TypeAdapter(VideoTrialRequest),
    (KIND_IMAGE, OPERATION_GENERATE): TypeAdapter(ImageGenerationIn),
    (KIND_VIDEO, OPERATION_COMPOSE): TypeAdapter(VideoComposeRequest),
    (KIND_SUBTITLE, OPERATION_GENERATE): TypeAdapter(SubtitleRequest),
    (KIND_DUBBING, OPERATION_GENERATE): TypeAdapter(DubbingRequest),
    (KIND_SPEECH, OPERATION_GENERATE): TypeAdapter(SpeechRequest),
    (KIND_AUDIO, OPERATION_GENERATE): TypeAdapter(MusicRequest),
    (KIND_WHOLE_FILM, OPERATION_RENDER): TypeAdapter(WholeFilmRequest),
    (KIND_VIDEO, OPERATION_ENHANCE): TypeAdapter(VideoEnhanceRequest),
}

_EDIT: Final[TypeAdapter[Any]] = TypeAdapter(VideoEditRequest)

_WITHOUT_REQUEST: Final = frozenset({(KIND_IMAGE, OPERATION_CUT)})


def request_from_payload(
    kind: str, operation: str, payload: dict[str, Any] | None, *, has_source: bool
) -> GenerationRequest | None:
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
