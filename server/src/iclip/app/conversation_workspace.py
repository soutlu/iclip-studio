from __future__ import annotations

import uuid

from cue.errors import ValidationFailed
from cue.file_store.namespace import namespace_for
from cue.file_store.store import InvalidPath, normalize_path
from iclip_video.iclip_studio.film.checks import check_project_content, check_run_content
from iclip_video.shot_document import validate_shots_document

from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.domains.conversations.service import DerivedFile, DerivedFileContent


class ConversationWorkspace:
    def __init__(self, store: WorkspaceFiles) -> None:
        self._store = store

    async def list_files(
        self, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> tuple[DerivedFile, ...]:

        entries = await self._store.entries(namespace_for(owner, str(conversation_id)))
        return tuple(
            DerivedFile(
                path=entry.path,
                size_bytes=entry.size_bytes,
                version=entry.version,
                updated_at=entry.updated_at,
            )
            for entry in entries
        )

    async def read_file(
        self, owner: uuid.UUID, conversation_id: uuid.UUID, path: str
    ) -> DerivedFileContent | None:
        stored = await self._store.read(namespace_for(owner, str(conversation_id)), path)
        if stored is None:
            return None
        return DerivedFileContent(path=stored.path, content=stored.content, version=stored.version)

    async def write_file(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        path: str,
        content: str,
        expected_version: int,
    ) -> DerivedFileContent:
        try:
            if normalize_path(path) != path:
                raise ValidationFailed(f"路径 {path!r} 不是规范形式，按工作区文件列表里的写法给")
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        entry = await self._store.write(
            namespace_for(owner, str(conversation_id)),
            path,
            content,
            expected_version=expected_version,
        )
        return DerivedFileContent(path=entry.path, content=content, version=entry.version)


async def validate_video_shots(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    _ = (owner, conversation_id)
    try:
        validate_shots_document(content)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from exc


async def validate_film(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    _ = (owner, conversation_id)
    _reject(check_project_content(content))


async def validate_film_run(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    _ = (owner, conversation_id)
    _reject(check_run_content(content))


def _reject(problems: list[str]) -> None:
    if problems:
        more = f"（共 {len(problems)} 处）" if len(problems) > 1 else ""
        raise ValidationFailed(problems[0] + more)


__all__ = [
    "ConversationWorkspace",
    "validate_film",
    "validate_film_run",
    "validate_video_shots",
]
