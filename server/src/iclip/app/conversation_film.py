"""制作页的组合根适配：AI 导演的工程文件在工作区，图片地址在用到它的那一步查能不能打开。

读、检查与写回的规则都在 ``iclip_video.iclip_studio.film``；这里只管拿文件、查地址和写文件。打开制作页
只查结构，不探地址：写错的图在页面上是一张打不开的缩略图，到插入、选用或生成时才拦下。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import StoredFile
from agent_runtime.http.errors import validation_error_detail
from iclip_video.film_view import FilmImagePrompt, FilmTextEdit, FilmView
from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip_video.iclip_studio.film.load import load_film
from iclip_video.iclip_studio.film.prompts import video_row
from iclip_video.iclip_studio.film.studio import (
    FilmEditRejected,
    choose_image,
    edit_text,
    film_groups,
    image_prompt,
    missing_references,
    music_description,
    set_aspect_ratio,
)
from iclip_video.iclip_studio.ports import InvalidNodeImageRequest, NodeImageRequest
from pydantic import ValidationError

from iclip.app.film_images import FILM_NODE_KEY, FilmImagesAdapter
from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.domains.generation.schemas import VideoGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal, resolve_user_name
from iclip.platform.outbound.media_check import UrlProber, bad_images

_STALE = "分镜刚被改过，刷新后再改"
_BROKEN = "分镜现在有问题，等 AI 导演改好再改"


@dataclass(frozen=True, slots=True)
class _Files:
    namespace: str
    project: StoredFile
    run: StoredFile | None


class ConversationFilmAdapter:
    """对话域制作页端口的实现。

    ``store`` 读写工作区：写成功后运行时发文件变更帧，打开着的页面据此重读。``probe`` 探图片地址（组合根接
    出网下载器的 ``probe``）。``generation`` 为 None 表示没开媒体生成，生成的两步答「还没开生成」。"""

    def __init__(
        self,
        *,
        store: WorkspaceFiles,
        probe: UrlProber,
        generation: GenerationService | None,
    ) -> None:
        self._store = store
        self._probe = probe
        self._generation = generation
        self._node_images = None if generation is None else FilmImagesAdapter(generation)

    async def view(
        self, principal: Principal, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> FilmView | None:
        files = await self._read(owner, conversation_id)
        if files is None:
            return None
        film = _load(files)
        run_version = None if files.run is None else files.run.version
        if isinstance(film, list):
            return FilmView(files.project.version, run_version, len(film), ())
        groups = film_groups(film, files.project.content)
        return FilmView(files.project.version, run_version, 0, groups, music_description(film))

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
        film = _clean(files)
        try:
            edited = edit_text(
                files.project.content, None if files.run is None else files.run.content, film, edits
            )
        except FilmEditRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        # 只查新插进列表的图：列表里原有的不归这一步管。
        await self._require_images(
            [
                (_inserted_label(index, len(edited.inserted)), url)
                for index, url in enumerate(edited.inserted, start=1)
            ]
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
        film = _clean(files)
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
            await self._require_images([("这张图", url)])
        # 选用机位图时两个文件都要写，先后由 choose_image 定：后一个没写成时留下的状态出片会被拦住。
        # 还没有运行文件时没有版本可对，新建的这一份直接写。
        for path, content in changes:
            expected = film_version if path == FILM_PATH else run_version
            await self._write(files.namespace, path, content, expected)
        return await self._fresh(principal, owner, conversation_id)

    async def set_aspect_ratio(
        self,
        principal: Principal,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        aspect_ratio: str,
        film_version: int,
    ) -> FilmView:
        files = await self._existing(owner, conversation_id)
        # 只写工程文件，同改字只对它的版本。
        if files.project.version != film_version:
            raise Conflict(_STALE)
        film = _clean(files)
        try:
            updated = set_aspect_ratio(film, files.project.content, aspect_ratio)
        except FilmEditRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        if updated is not None:
            await self._write(files.namespace, FILM_PATH, updated, film_version)
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
        film = _clean(files)
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
        _require_selected(missing_references(film, node))
        if prompt is None:
            picture = image_prompt(film, node)
            text, references = picture.text, picture.image_urls
        else:
            text, references = prompt.text, prompt.reference_image_urls
        await self._require_images(_references(references))
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
        film = _clean(files)
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
        _require_selected(missing_references(film, video))
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
        await self._require_images(_references(row.image_urls))
        job = await generation.submit_video(principal, request)
        return job.id

    def _require_generation(self) -> GenerationService:
        if self._generation is None:
            raise ValidationFailed("这里还没开生成，暂时不能生成")
        return self._generation

    async def _require_images(self, items: Sequence[tuple[str, str]]) -> None:
        """``items``（称呼，地址）里的图都要能打开、是图片；不行就按称呼说哪张，不带地址。"""

        bad = await bad_images(self._probe, (url for _, url in items))
        listed = [f"{label}{bad[url]}" for label, url in items if url in bad]
        if listed:
            raise ValidationFailed(f"{'；'.join(listed)}，请换一张图")

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

    async def _write(self, namespace: str, path: str, content: str, expected: int | None) -> None:
        # 内容或容量不合规的 ValidationFailed 原样往外抛。
        try:
            await self._store.write(namespace, path, content, expected_version=expected)
        except Conflict as exc:
            raise Conflict(_STALE) from exc


def _load(files: _Files) -> Film | list[str]:
    return load_film(files.project.content, None if files.run is None else files.run.content)


def _clean(files: _Files) -> Film:
    """页面只在检查通过的分镜上改；有问题时改了也分不清是谁的。"""

    film = _load(files)
    if isinstance(film, list):
        raise ValidationFailed(_BROKEN)
    return film


def _references(urls: Sequence[str]) -> list[tuple[str, str]]:
    """参考图按列表里的位置称呼，同页面上的编号。"""

    return [(f"第 {n} 张参考图", url) for n, url in enumerate(urls, start=1)]


def _inserted_label(index: int, total: int) -> str:
    return "插入的图" if total == 1 else f"插入的第 {index} 张图"


def _require_selected(missing: tuple[str, ...]) -> None:
    """参考图列表里每一张都要有图才能生成；缺的按称呼列出来。"""

    if missing:
        raise ValidationFailed(f"以下参考图尚未选用：{'、'.join(missing)}；无法生成")


__all__ = ["ConversationFilmAdapter"]
