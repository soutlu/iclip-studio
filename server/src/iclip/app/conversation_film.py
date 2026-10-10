"""制作页的组合根适配：AI 导演的工程文件在工作区，图片地址在素材台账与生成记录里。

读、检查与写回的规则都在 ``capabilities/iclip_studio/film``；这里只管拿文件、认地址和写文件。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from pydantic import ValidationError

from iclip.app.film_images import FILM_NODE_KEY, FilmImagesAdapter
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.load import ConversationImages, load_film
from iclip.capabilities.iclip_studio.film.prompts import video_row
from iclip.capabilities.iclip_studio.film.studio import (
    FilmEditRejected,
    choose_image,
    edit_text,
    film_groups,
    image_prompt,
    missing_references,
)
from iclip.capabilities.iclip_studio.ports import InvalidNodeImageRequest, NodeImageRequest
from iclip.capabilities.workspace.scope import namespace_for
from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.common.film_view import FilmImagePrompt, FilmTextEdit, FilmView
from iclip.domains.generation.schemas import VideoGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal, resolve_user_name
from iclip.platform.file_store.store import (
    FileStore,
    InvalidContent,
    QuotaExceeded,
    StoredFile,
    VersionConflict,
)
from iclip.platform.http import validation_error_detail
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
    ``generation`` 为 None 表示没开媒体生成：只认素材台账里的图，认不出生成记录与上传。"""

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
        self._node_images = None if generation is None else FilmImagesAdapter(generation)

    async def view(
        self, principal: Principal, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> FilmView | None:
        files = await self._read(owner, conversation_id)
        if files is None:
            return None
        film = await self._load(files)
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
        film = await self._clean(files)
        for url in dict.fromkeys(url for edit in edits for url in edit.images):
            if not await self._choosable(principal, conversation_id, files, url):
                raise ValidationFailed("只能插入这段对话里的图，或你自己上传的图")
        try:
            edited = edit_text(
                files.project.content, None if files.run is None else files.run.content, film, edits
            )
        except FilmEditRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        if edited.inserted:
            # 同换图：插进列表的图先登记再写文件，文件写进去时它已经是对话素材。
            await self._ledger.record(
                files.namespace, [Material(url=url, kind="image") for url in edited.inserted]
            )
        await self._write(files.namespace, FILM_PATH, edited.source, film_version)
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
        self._check_versions(files, film_version, run_version)
        film = await self._clean(files)
        if url is not None and not await self._choosable(principal, conversation_id, files, url):
            raise ValidationFailed("只能换成这段对话里的图，或你自己上传的图")
        try:
            changes = choose_image(
                film,
                files.project.content,
                None if files.run is None else files.run.content,
                node,
                url,
            )
        except FilmEditRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        if url is not None:
            # 选用的图不论生成、编辑还是上传，一律先登记再写文件：文件写进去时它已经是对话素材，
            # 检查时认得它；做同款拷台账就带上了运行文件选用的每一张。已选用的再选一次也登记，
            # 没登记过的就此补上；重复登记保留首条，没有别的副作用。
            await self._ledger.record(files.namespace, [Material(url=url, kind="image")])
        # 选用机位图时两个文件都要写，先后由 choose_image 定：后一个没写成时留下的状态出片会被拦住。
        # 还没有运行文件时没有版本可对，新建的这一份直接写。
        for path, content in changes:
            expected = film_version if path == FILM_PATH else run_version
            await self._write(files.namespace, path, content, expected)
        return await self._fresh(principal, owner, conversation_id)

    async def generate_image(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        node: str,
        prompt: FilmImagePrompt | None,
        film_version: int,
        run_version: int | None,
    ) -> uuid.UUID:
        generation = self._require_generation()
        assert self._node_images is not None
        files = await self._existing(owner, conversation_id)
        self._check_versions(files, film_version, run_version)
        film = await self._clean(files)
        project = film.project
        target = project.nodes.get(node)
        tag = None if target is None else project.tags.get(target.tag)
        if (
            target is None
            or tag is None
            or tag.generation is None
            or node not in {item.attrs["id"] for item in film.image_nodes()}
        ):
            raise ValidationFailed("这张图不能按描述生成")
        model = tag.generation.gateway
        if model not in {name for name, _ in generation.image_models()[1]}:
            raise ValidationFailed("生图模型还没接上，暂时不能生成")
        _require_images(missing_references(film, node))
        if prompt is None:
            picture = image_prompt(film, node)
            text, references = picture.text, picture.image_urls
        else:
            text, references = prompt.text, prompt.reference_image_urls
        request = NodeImageRequest(
            node=node,
            prompt=text,
            model=model,
            aspect_ratio=target.attrs["aspect-ratio"],
            resolution=target.attrs["resolution"],
            reference_image_urls=references,
            user_name=resolve_user_name(principal, None),
            conversation_id=str(conversation_id),
        )
        try:
            job = await self._node_images.submit(principal, request)
        except InvalidNodeImageRequest as exc:
            raise ValidationFailed(f"这次没有生成：{exc}") from exc
        return job.job_id

    async def generate_video(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        video: str,
        model: str,
        resolution: str,
        generate_audio: bool,
        film_version: int,
        run_version: int | None,
    ) -> uuid.UUID:
        generation = self._require_generation()
        files = await self._existing(owner, conversation_id)
        self._check_versions(files, film_version, run_version)
        film = await self._clean(files)
        videos = film.project.find("ReferenceVideo")
        found = next(
            (
                (index, item)
                for index, item in enumerate(videos, start=1)
                if item.attrs["id"] == video
            ),
            None,
        )
        if found is None:
            raise ValidationFailed("找不到这一组，刷新后再出片")
        index, target = found
        _require_images(missing_references(film, video))
        row = video_row(film, target, index)
        try:
            request = VideoGenerationIn.model_validate(
                {
                    "model": model,
                    "shot": row.prompt.model_dump(),
                    "reference_image_urls": row.image_urls,
                    "generate_audio": generate_audio,
                    "resolution": resolution,
                    "aspect_ratio": target.attrs["aspect-ratio"],
                    "seconds": row.seconds,
                    "user_name": resolve_user_name(principal, None),
                    "conversation_id": conversation_id,
                    "metadata": {FILM_NODE_KEY: video},
                    "shot_index": index,
                }
            )
        except ValidationError as exc:
            raise ValidationFailed(validation_error_detail(exc.errors())) from exc
        job = await generation.submit_video(principal, request)
        return job.id

    def _require_generation(self) -> GenerationService:
        if self._generation is None:
            raise ValidationFailed("这里还没开生成，暂时不能生成")
        return self._generation

    @staticmethod
    def _check_versions(files: _Files, film_version: int, run_version: int | None) -> None:
        current_run = None if files.run is None else files.run.version
        if files.project.version != film_version or current_run != run_version:
            raise Conflict(_STALE)

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

    async def _choosable(
        self, principal: Principal, conversation_id: uuid.UUID, files: _Files, url: str
    ) -> bool:
        """能不能选用这个地址：对话素材，这段对话出过的图（制作页上刚生成或编辑出的版本选用前还不在
        素材台账里），或调用者自己上传的图。选用时都会登记成对话素材。"""

        if await ConversationImages(self._ledger, files.namespace).known(url):
            return True
        if self._generation is None or self._node_images is None:
            return False
        if await self._node_images.belongs(principal, str(conversation_id), url):
            return True
        return await self._generation.find_upload(principal, url) is not None

    async def _load(self, files: _Files) -> Film | list[str]:
        return await load_film(
            files.project.content,
            None if files.run is None else files.run.content,
            images=ConversationImages(self._ledger, files.namespace),
        )

    async def _clean(self, files: _Files) -> Film:
        """页面只在检查通过的分镜上改；有问题时改了也分不清是谁的。"""

        film = await self._load(files)
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


def _require_images(missing: tuple[str, ...]) -> None:
    """参考图列表里每一张都要有图才能生成；缺的按称呼列出来。"""

    if missing:
        raise ValidationFailed(f"以下参考图尚未选用：{'、'.join(missing)}；无法生成")


__all__ = ["ConversationFilmAdapter"]
