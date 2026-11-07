from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic_ai.messages import ImageUrl, UserContent

from cue.errors import ValidationFailed
from cue.harness.media import (
    IMAGE_CONTEXT_MAX_EDGE,
    MediaKind,
    is_media_tag_close,
    media_tag,
    media_tag_close,
    media_tag_open,
    parse_media_tag,
    resized_image_url,
)
from cue.transcript.ops import (
    AttachmentSource,
    ImageContent,
    PromptContent,
    TextContent,
    VideoContent,
)


def model_prompt(content: Sequence[PromptContent]) -> list[UserContent]:
    out: list[UserContent] = []
    for part in content:
        if part.type == "text":
            out.append(part.text)
            continue
        url = part.source.url
        if url is None:
            continue
        kind: MediaKind = "image" if part.type == "image" else "video"
        if kind == "video":
            out.append(media_tag(kind, url))
            continue
        try:
            view = resized_image_url(url, max_edge=IMAGE_CONTEXT_MAX_EDGE)
        except ValueError as exc:
            raise ValidationFailed(
                f"图片附件的地址挂不上缩放参数，模型看不到这张图：{exc}"
            ) from exc
        out.append(media_tag_open(kind, url))
        out.append(ImageUrl(url=view))
        out.append(media_tag_close(kind))
    return out


def prompt_content(items: Sequence[Any]) -> tuple[PromptContent, ...]:
    parts: list[PromptContent] = []
    for item in items:
        if not isinstance(item, str):
            continue
        if is_media_tag_close(item):
            continue
        tag = parse_media_tag(item)
        if tag is None:
            parts.append(TextContent(text=item))
            continue
        source = AttachmentSource(kind="url", url=tag.url)
        if tag.kind == "image":
            parts.append(ImageContent(source=source))
        elif tag.kind == "video":
            parts.append(VideoContent(source=source))
        else:
            parts.append(TextContent(text=item))
    return tuple(parts)


def plain_text(content: Sequence[PromptContent]) -> str:
    return "".join(part.text for part in content if part.type == "text")


__all__ = [
    "model_prompt",
    "plain_text",
    "prompt_content",
]
