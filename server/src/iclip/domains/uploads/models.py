from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

MediaKind = Literal["image", "video", "audio"]

UPLOAD_TYPES: Final[Mapping[str, tuple[MediaKind, str]]] = {
    "image/jpeg": ("image", "jpg"),
    "image/png": ("image", "png"),
    "image/webp": ("image", "webp"),
    "video/mp4": ("video", "mp4"),
    "video/quicktime": ("video", "mov"),
    "audio/mpeg": ("audio", "mp3"),
    "audio/wav": ("audio", "wav"),
    "audio/mp4": ("audio", "m4a"),
}

MAX_BYTES: Final[Mapping[MediaKind, int]] = {
    "image": 16 * 1024 * 1024,
    "video": 512 * 1024 * 1024,
    "audio": 50 * 1024 * 1024,
}

MIN_SHORT_EDGE_PIXELS: Final = 300
MAX_LONG_EDGE_PIXELS: Final = 6000

# 分叉对话看得到的祖先对话与分叉时刻：祖先对话里不晚于分叉时刻的上传算继承来的。
Inheritance = Sequence[tuple[uuid.UUID, datetime]]


@dataclass(frozen=True, slots=True)
class MediaUpload:
    """上传台账里的一条：一个直传或转存进桶的文件。

    ``url`` 是这次上传交回的地址；视频按 MD5 去重时是最早那份的地址。``content_type`` 与
    ``size_bytes`` 只有台账建立以前的旧上传为空；``width`` / ``height`` 只有图片记（确认时报的）；
    ``duration_ms`` 确认上传时不量，为空。
    """

    id: uuid.UUID
    owner_user_id: uuid.UUID
    api_key_id: uuid.UUID | None
    conversation_id: uuid.UUID | None
    kind: MediaKind
    url: str
    content_type: str | None
    size_bytes: int | None
    duration_ms: int | None
    width: int | None
    height: int | None
    content_md5: str | None
    created_at: datetime


__all__ = [
    "MAX_BYTES",
    "MAX_LONG_EDGE_PIXELS",
    "MIN_SHORT_EDGE_PIXELS",
    "UPLOAD_TYPES",
    "Inheritance",
    "MediaKind",
    "MediaUpload",
]
