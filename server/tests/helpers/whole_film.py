"""整片草稿文档的构造器：按 wire 形状（camelCase、整数毫秒）拼字典，测试只改要验证的那几处。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any


def video_clip(
    clip_id: str,
    *,
    start: int,
    duration: int,
    source_job_id: uuid.UUID,
    playback_start: int = 0,
    volume: float = 1,
) -> dict[str, Any]:
    return {
        "id": clip_id,
        "type": "video",
        "start": start,
        "duration": duration,
        "playbackStart": playback_start,
        "sourceJobId": str(source_job_id),
        "volume": volume,
    }


def component_clip(
    clip_id: str, *, start: int, duration: int, playback_start: int = 0
) -> dict[str, Any]:
    return {
        "id": clip_id,
        "type": "component",
        "start": start,
        "duration": duration,
        "playbackStart": playback_start,
        "component": "brand-intro",
        "variables": {"brand": "鞋款", "showLogo": True, "scale": 1.5},
    }


def overlay(
    clip_id: str,
    *,
    start: int,
    duration: int,
    track: int = 0,
    z_index: int = 1,
    playback_start: int = 0,
    x: int = 0,
    y: int = 0,
) -> dict[str, Any]:
    return {
        "id": clip_id,
        "component": "sticker",
        "start": start,
        "duration": duration,
        "playbackStart": playback_start,
        "track": track,
        "zIndex": z_index,
        "variables": {},
        "x": x,
        "y": y,
    }


def butted(clips: Sequence[tuple[str, int]], *, source_job_id: uuid.UUID) -> list[dict[str, Any]]:
    """一串首尾相接的视频片段，``(id, 时长)`` 依次排开，都出自 ``source_job_id``。"""

    layer: list[dict[str, Any]] = []
    start = 0
    for clip_id, duration in clips:
        layer.append(
            video_clip(clip_id, start=start, duration=duration, source_job_id=source_job_id)
        )
        start += duration
    return layer


def draft_document(
    *,
    source_job_id: uuid.UUID | None = None,
    layer0: list[dict[str, Any]] | None = None,
    edits: list[dict[str, Any]] | None = None,
    captions_hidden: bool = False,
    captions_at: tuple[int, int] = (0, 0),
    music: dict[str, Any] | None = None,
    overlays: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """合规矩的一份草稿：默认画面轨是两段视频（3 秒、2 秒），字幕开着、在原位，没有音乐与特效块。"""

    source = source_job_id or uuid.uuid4()
    default_layer = butted([("a", 3000), ("b", 2000)], source_job_id=source)
    return {
        "canvas": {"width": 1080, "height": 1920},
        "layer0": layer0 if layer0 is not None else default_layer,
        "captions": {
            "component": "captions-basic",
            "edits": edits or [],
            "hidden": captions_hidden,
            "x": captions_at[0],
            "y": captions_at[1],
        },
        "music": music,
        "overlays": overlays or [],
    }


__all__ = ["butted", "component_clip", "draft_document", "overlay", "video_clip"]
