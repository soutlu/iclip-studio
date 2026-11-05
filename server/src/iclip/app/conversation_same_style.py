from __future__ import annotations

import uuid
from typing import Final

from agent_runtime.file_store.namespace import namespace_for
from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH
from iclip_video.shot_document import SHOTS_PATH

from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.domains.conversations.service import SameStyleFiles
from iclip.domains.library.repository import LibraryReports

TREATMENT_PATH: Final = "treatment.md"

SAME_STYLE_FILES: Final = (
    (TREATMENT_PATH, TREATMENT_PATH),
    (FILM_PATH, "old_film.icml"),
    (RUN_PATH, RUN_PATH),
    (SHOTS_PATH, "old_video_shot.json"),
)

_PRODUCTION_FILES: Final = frozenset({FILM_PATH, SHOTS_PATH})

SAME_STYLE: Final = SameStyleFiles(files=SAME_STYLE_FILES, require_any=_PRODUCTION_FILES)


class ProductionFilesProbe:
    def __init__(self, store: WorkspaceFiles) -> None:
        self._store = store

    async def has_production_files(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> bool:
        entries = await self._store.entries(namespace_for(owner, str(conversation_id)))
        return any(entry.path in _PRODUCTION_FILES for entry in entries)


class LibrarySameStyleSource:
    def __init__(self, reports: LibraryReports) -> None:
        self._reports = reports

    async def __call__(self, card_id: uuid.UUID) -> uuid.UUID | None:
        row = await self._reports.card_of(card_id)
        return None if row is None else row.conversation_owner


__all__ = ["SAME_STYLE", "LibrarySameStyleSource", "ProductionFilesProbe"]
