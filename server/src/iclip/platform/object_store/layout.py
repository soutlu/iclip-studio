from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final

OSS_ROOT: Final = "iclip/agent"


@dataclass(frozen=True, slots=True)
class MediaPaths:
    def chat_media(self, *, digest: str, ext: str) -> str:
        return f"{OSS_ROOT}/chat-media/{digest}.{ext}"

    def generated_image(self, *, job_id: uuid.UUID, ext: str) -> str:

        return f"{OSS_ROOT}/generated-images/{job_id}.{ext}"

    def generated_music(self, *, job_id: uuid.UUID, ext: str) -> str:

        return f"{OSS_ROOT}/generated-music/{job_id}.{ext}"

    def generated_dubbing(self, *, job_id: uuid.UUID, ext: str) -> str:
        return f"{OSS_ROOT}/generated-dubbing/{job_id}.{ext}"

    def video_master(self, *, job_id: uuid.UUID, ext: str) -> str:
        return f"{OSS_ROOT}/video-masters/{job_id}.{ext}"

    def edit_reference(self, *, job_id: uuid.UUID) -> str:
        return f"{OSS_ROOT}/edit-references/{job_id}.mp4"

    def whole_film(self, *, job_id: uuid.UUID) -> str:
        return f"{OSS_ROOT}/whole-films/{job_id}.mp4"

    def shot_board(self, *, extraction_key: str, index: int) -> str:
        return f"{OSS_ROOT}/shot-frames/{extraction_key}/board/{index}.jpg"

    def shot_cell(self, *, job_id: uuid.UUID, cell_id: str) -> str:

        return f"{OSS_ROOT}/shot-frames/{job_id}/out/{cell_id}.jpg"

    def anchor_sheet(self, *, job_id: uuid.UUID, index: int) -> str:

        return f"{OSS_ROOT}/anchor-sheets/{job_id}/{index}.jpg"

    def upload(self, *, upload_id: uuid.UUID, ext: str) -> str:

        return f"{OSS_ROOT}/uploads/{upload_id}.{ext}"

    def upload_prefix(self, *, upload_id: uuid.UUID) -> str:
        return f"{OSS_ROOT}/uploads/{upload_id}."


MEDIA_PATHS: Final = MediaPaths()


__all__ = ["MEDIA_PATHS", "OSS_ROOT", "MediaPaths"]
