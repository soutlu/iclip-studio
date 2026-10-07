"""制作页的组合根适配：AI 导演的工程文件在工作区，图片地址在素材台账与生成记录里。

读、检查与写回的规则都在 ``capabilities/iclip_studio/film``；这里只管拿文件、认地址和写文件。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from iclip.app.capability_table import FilmImagesAdapter
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.load import ConversationImages, load_film
from iclip.capabilities.iclip_studio.film.studio import (
    FilmEditRejected,
    choose_image,
    edit_text,
    film_groups,
)
from iclip.capabilities.workspace.scope import namespace_for
from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.common.film_view import FilmTextEdit, FilmView
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.platform.file_store.store import (
    FileStore,
    InvalidContent,
    QuotaExceeded,
    StoredFile,
    VersionConflict,
)
from iclip.platform.material_ledger.store import Material, MaterialLedger

_STALE = "分镜刚被改过，刷新后再改"
_BROKEN = "分镜现在有问题，等 AI 导演改好再改"


@dataclass(frozen=True, slots=True)
class _Files:
    namespace: str
    project: StoredFile
    run: StoredFile | None


class ConversationFilmAdapter:
    """对话域制作页端口的实现。

    ``store`` 用来读，``announcing`` 用来写：写成功后照常发文件变更帧，打开着的页面据此重读。
    ``generation`` 为 None 表示没开媒体生成：只认素材台账里的图，查不到最近生成的图，也认不出
    上传。"""

    def __init__(
        self,
        *,
        store: FileStore,
        announcing: FileStore,
        ledger: MaterialLedger,
        generation: GenerationService | None,
    ) -> None:
        self._store = store
        self._announcing = announcing
        self._ledger = ledger
        self._generation = generation

    async def view(
        self, principal: Principal, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> FilmView | None:
        files = await self._read(owner, conversation_id)
        if files is None:
            return None
        film = await self._load(principal, conversation_id, files)
        run_version = None if files.run is None else files.run.version
        if isinstance(film, list):
            return FilmView(files.project.version, run_version, len(film), ())
        groups = film_groups(film, files.project.content)
        return FilmView(files.project.version, run_version, 0, groups)

    async def edit_text(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        edits: Sequence[FilmTextEdit],
        *,
        film_version: int,
    ) -> FilmView:
        files = await self._existing(owner, conversation_id)
        if files.project.version != film_version:
            raise Conflict(_STALE)
        film = await self._clean(principal, conversation_id, files)
        try:
            updated = edit_text(files.project.content, film, edits)
        except FilmEditRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        await self._write(files.namespace, FILM_PATH, updated, film_version)
        return await self._fresh(principal, owner, conversation_id)

    async def choose_image(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        node: str,
        url: str | None,
        film_version: int,
        run_version: int | None,
    ) -> FilmView:
        files = await self._existing(owner, conversation_id)
        current_run = None if files.run is None else files.run.version
        if files.project.version != film_version or current_run != run_version:
            raise Conflict(_STALE)
        film = await self._clean(principal, conversation_id, files)
        upload = False
        if url is not None and not await self._images(principal, conversation_id, files).known(url):
            found = (
                None
                if self._generation is None
                else await self._generation.find_upload(principal, url)
            )
            if found is None:
                raise ValidationFailed("只能换成这段对话里的图，或你自己上传的图")
            upload = True
        try:
            change = choose_image(
                film,
                files.project.content,
                None if files.run is None else files.run.content,
                node,
                url,
            )
        except FilmEditRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        if change is None:
            return await self._fresh(principal, owner, conversation_id)
        if upload and url is not None:
            # 先登记再写文件：文件写进去时这张图已经是对话素材，AI 导演检查时认得它。
            await self._ledger.record(files.namespace, [Material(url=url, kind="image")])
        path, content = change
        # 还没有运行文件时没有版本可对，新建的这一份直接写。
        expected = film_version if path == FILM_PATH else run_version
        await self._write(files.namespace, path, content, expected)
        return await self._fresh(principal, owner, conversation_id)

    async def _read(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> _Files | None:
        namespace = namespace_for(owner, str(conversation_id))
        project = await self._store.read(namespace, FILM_PATH)
        if project is None:
            return None
        return _Files(namespace, project, await self._store.read(namespace, RUN_PATH))

    async def _existing(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> _Files:
        files = await self._read(owner, conversation_id)
        if files is None:
            raise NotFound("这段对话里没有 AI 导演写的分镜")
        return files

    async def _fresh(
        self, principal: Principal, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> FilmView:
        view = await self.view(principal, owner, conversation_id)
        if view is None:
            raise NotFound("这段对话里没有 AI 导演写的分镜")
        return view

    def _images(
        self, principal: Principal, conversation_id: uuid.UUID, files: _Files
    ) -> ConversationImages:
        return ConversationImages(
            ledger=self._ledger,
            namespace=files.namespace,
            images=None if self._generation is None else FilmImagesAdapter(self._generation),
            principal=principal,
            conversation_id=str(conversation_id),
        )

    async def _load(
        self, principal: Principal, conversation_id: uuid.UUID, files: _Files
    ) -> Film | list[str]:
        return await load_film(
            files.project.content,
            None if files.run is None else files.run.content,
            images=self._images(principal, conversation_id, files),
        )

    async def _clean(self, principal: Principal, conversation_id: uuid.UUID, files: _Files) -> Film:
        """页面只在检查通过的分镜上改；有问题时改了也分不清是谁的。"""

        film = await self._load(principal, conversation_id, files)
        if isinstance(film, list):
            raise ValidationFailed(_BROKEN)
        return film

    async def _write(self, namespace: str, path: str, content: str, expected: int | None) -> None:
        try:
            await self._announcing.write(namespace, path, content, expected_version=expected)
        except VersionConflict as exc:
            raise Conflict(_STALE) from exc
        except (InvalidContent, QuotaExceeded) as exc:
            raise ValidationFailed(str(exc)) from exc


__all__ = ["ConversationFilmAdapter"]
