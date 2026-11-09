from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from agent_runtime.file_store.store import FileSpace
from agent_runtime.harness.materials import require_media
from agent_runtime.harness.media_check import bad_urls
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.run_deps import AgentRunDeps
from agent_runtime.transcript.display import (
    MEDIA_GRID_VIEW,
    DisplayFn,
    GenericDisplay,
    ToolDisplayEntry,
    media_grid,
    tool_note,
)
from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import CapabilityOrdering
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext
from pydantic_ai.toolsets import FunctionToolset

from iclip_video.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip_video.iclip_studio.film.load import image_problems, load_film
from iclip_video.iclip_studio.film.markup import Node
from iclip_video.iclip_studio.film.packages import IMAGE
from iclip_video.iclip_studio.film.prompts import render_picture, render_video
from iclip_video.iclip_studio.ports import (
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
    NodeImages,
)
from iclip_video.shot_prompt import format_shot_prompt

CAPABILITY_ID: Final = "iclip_studio"

MAX_LISTED_PROBLEMS: Final = 30

MAX_IMAGES_PER_CALL: Final = 10

IMAGE_POLL_SECONDS: Final = 3.0
IMAGE_WAIT_SECONDS: Final = 900.0


@dataclass
class IclipStudio(CapPlugin[AgentDepsT]):
    label = "导演工程"
    summary = "检查 AI 导演的工程文件和运行文件是否符合规范。"

    space: FileSpace

    images: NodeImages | None = None

    can_generate: bool = False

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> IclipStudioToolset[AgentDepsT]:
        return IclipStudioToolset(self)

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(cls, *, space: FileSpace, images: NodeImages | None) -> type[Self]:
        return cls._bound(space=space, images=images)

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(requires=(Workspace,))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {
            "check_film": lambda args: GenericDisplay(summary="检查工程", detail=FILM_PATH),
            "generate_images": ToolDisplayEntry(
                draw=lambda args: GenericDisplay(summary="生成图片", detail=_node_names(args)),
                view=MEDIA_GRID_VIEW,
            ),
        }


class IclipStudioToolset(FunctionToolset[AgentDepsT]):
    def __init__(self, capability: IclipStudio[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_function(self.check_film, name="check_film")
        if capability.images is not None and capability.can_generate:
            self.add_function(self.generate_images, name="generate_images")

    async def check_film(
        self, ctx: RunContext[AgentDepsT], show: str | list[str] | None = None
    ) -> ToolReturn[str]:
        """检查工程文件 film.icml 和运行文件 film.icrun 是否符合工程规范，包括文件结构、引用关系、
        参数，以及文件里的图片地址能否打开、是否为有效图片。

        - 检查分阶段进行，返回本次发现的问题及文件位置，单次最多列出 30 处；修正后需重新检查。
        - 图片尚未选用不影响工程规范检查；可用 `show` 查看指定节点的最终提示词、参考图和缺图情况，带 `show` 时会先完整检查，不用先单独调用一次。

        Args:
            show: 填写 film.icml 中图片或视频生成节点的 id，可填一个或多个，如 "镜02机位图" 或
                ["全片", "第1组"]。工程规范检查通过后，返回这些节点的最终提示词、参考图及尚未选用的
                参考图。
        """

        film = await self._load(ctx)
        if isinstance(film, list):
            return _problems(film)
        project = film.project
        videos = project.find("ReferenceVideo")
        shown: list[Node] = []
        for name in dict.fromkeys([show] if isinstance(show, str) else show or []):
            node = project.nodes.get(name)
            tag = project.tags.get(node.tag) if node is not None else None
            if node is None or tag is None or tag.generation is None:
                names = "、".join(n.attrs["id"] for n in [*film.image_nodes(), *videos])
                raise ModelRetry(f"show 要填某张图或某段视频的 id，可以填：{names}。")
            shown.append(node)
        problems = await self._image_problems(film)
        if problems:
            return _problems(problems)
        lines = [
            f"工程规范检查通过：{len(film.image_nodes())} 个图片生成节点，{len(videos)} 个视频生成节点。"
        ]
        for node in shown:
            lines += ["", *_assembled(film, node)]
        return ToolReturn(return_value="\n".join(lines), metadata=tool_note(chip="通过"))

    async def generate_images(
        self, ctx: RunContext[AgentDepsT], nodes: list[str]
    ) -> ToolReturn[str]:
        """生成 film.icml 里指定的生图节点，每个节点出一张图，返回每张图的地址。

        - 只在用户明确要求生成哪些图时调用；每次调用都会对列出的节点重新生成，已生成过且用户未要求重做的节点不要再列。
        - 一次最多传入 10 个节点，超过 10 个时分多次调用。
        - 生成前先做与 `check_film` 相同的规范检查，并检查目标节点用到的参考图能否打开，有问题则不生成。
        - 运行文件里已选用登记图的节点不生成；所挂参考图中有尚未选用的节点也不生成，结果里会列出缺哪几张，等用户在制作页选用后再生成。
        - 单张失败不影响其它张，失败原因在结果里说明，禁止自动重试。
        - 生成出来的图不会自动用上，需用户在制作页选用后才生效。

        Args:
            nodes: 要生成的生图节点 id 列表，如 `["短发女生设定图", "镜01机位图"]`。
        """

        images = self._cap.images
        assert images is not None, "没有生图端口时不登记这件工具"
        film = await self._load(ctx)
        if isinstance(film, list):
            listed = "\n".join(film[:MAX_LISTED_PROBLEMS])
            raise ModelRetry(f"检查没通过，没有生成。先改掉这 {len(film)} 处问题：\n{listed}")
        known = {node.attrs["id"]: node for node in film.image_nodes()}
        if not nodes or len(nodes) > MAX_IMAGES_PER_CALL or len(set(nodes)) != len(nodes):
            raise ModelRetry(
                f"nodes 要写 1–{MAX_IMAGES_PER_CALL} 个不重复的生图节点名；更多的分几次调用。"
            )
        unknown = [name for name in nodes if name not in known]
        if unknown:
            raise ModelRetry(f"{'、'.join(unknown)} 不是生图节点；可以写：{'、'.join(known)}。")
        targets = [name for name in known if name in nodes]
        outcome: dict[str, str] = {}
        made: list[tuple[str, str]] = []
        pending: list[str] = []
        for name in targets:
            missing = render_picture(film, known[name]).missing
            if name in film.selected:
                outcome[name] = (
                    f"没有生成，运行文件里选用了「{film.selected[name]}」；要重新生成先删掉它的 use"
                )
            elif missing:
                outcome[name] = f"没有生成，参考图 {'、'.join(missing)} 还没有选用图"
            else:
                pending.append(name)
        await require_media(
            [
                (f"{name} 的 @Image{n}", url)
                for name in pending
                for n, url in enumerate(render_picture(film, known[name]).image_urls, start=1)
            ],
            kind="image",
            what="参考图地址",
        )
        deps = _deps(ctx)
        results = await asyncio.gather(
            *(self._generate(images, deps, film, known[name]) for name in pending)
        )
        for name, job in zip(pending, results, strict=True):
            if job.status == "completed" and job.output_url:
                made.append((job.output_url, name))
                outcome[name] = f"已生成，地址 {job.output_url}"
            else:
                outcome[name] = f"生成失败，{job.error_message or '没有说明原因'}"
        failed = sum(1 for text in outcome.values() if text.startswith("生成失败"))
        skipped = len(targets) - len(made) - failed
        lines = [f"生成结束：{len(made)} 张成功，{failed} 张失败，{skipped} 个没有生成。"]
        lines += [f"{name}：{outcome[name]}" for name in targets]
        return ToolReturn(
            return_value="\n".join(lines),
            metadata=media_grid(made, note=f"{len(made)} 张"),
        )

    async def _generate(
        self, images: NodeImages, deps: AgentRunDeps, film: Film, node: Node
    ) -> NodeImageJob:
        project = film.project
        picture = render_picture(film, node)
        tag = project.declared(node)
        assert tag.generation is not None
        try:
            job = await images.submit(
                deps.user_id,
                NodeImageRequest(
                    node=node.attrs["id"],
                    prompt=picture.text,
                    model=tag.generation.gateway,
                    aspect_ratio=node.attrs["aspect-ratio"],
                    resolution=node.attrs["resolution"],
                    reference_image_urls=picture.image_urls,
                    user_name=deps.user_name,
                    conversation_id=deps.conversation_id,
                ),
            )
        except InvalidNodeImageRequest as exc:
            return NodeImageJob(uuid.UUID(int=0), "failed", error_message=f"请求被拒：{exc}")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + IMAGE_WAIT_SECONDS
        while not job.finished:
            if loop.time() >= deadline:
                return NodeImageJob(
                    job.job_id,
                    "failed",
                    error_message="等超时了；它可能还在后台跑，告诉用户稍后到制作页上看这张图",
                )
            await asyncio.sleep(IMAGE_POLL_SECONDS)
            job = await images.get(deps.user_id, job.job_id)
        return job

    async def _load(self, ctx: RunContext[AgentDepsT]) -> Film | list[str]:
        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        project = await files.read(namespace, FILM_PATH)
        if project is None:
            raise ModelRetry(f"工作区里没有 {FILM_PATH}；先按规范把它写出来。")
        run = await files.read(namespace, RUN_PATH)
        return load_film(project.content, None if run is None else run.content)

    async def _image_problems(self, film: Film) -> list[str]:
        bad = await bad_urls([node.attrs["src"] for _, node in film.given_images()], kind="image")
        return image_problems(film, bad) if bad else []


def _problems(problems: list[str]) -> ToolReturn[str]:
    listed = problems[:MAX_LISTED_PROBLEMS]
    lines = [f"工程规范检查未通过，本次发现 {len(problems)} 处问题：", *listed]
    if len(problems) > len(listed):
        lines.append(f"仅列出前 {len(listed)} 处，修正后重新检查。")
    return ToolReturn(
        return_value="\n".join(lines), metadata=tool_note(chip=f"{len(problems)} 处问题")
    )


def _assembled(film: Film, node: Node) -> list[str]:
    name = node.attrs["id"]
    if film.project.declared(node).output == ("image", IMAGE):
        picture = render_picture(film, node)
        head = f"{name}：画幅 {node.attrs['aspect-ratio']}，分辨率 {node.attrs['resolution']}"
        text, images = picture.text, picture.images
    else:
        group = render_video(film, node)
        head = f"{name}：{group.seconds} 秒，画幅 {node.attrs['aspect-ratio']}"
        text, images = format_shot_prompt(group), group.images
    listed = (
        "、".join(
            f"@Image{n} = {item.image} {item.url}"
            if item.url
            else f"@Image{n} = {item.image}（尚未选用图片）"
            for n, item in enumerate(images, start=1)
        )
        or "无"
    )
    return [head, f"参考图：{listed}", "", text]


def _deps(ctx: RunContext[Any]) -> AgentRunDeps:
    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"这次运行的 deps 是 {type(deps).__name__}，不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return deps


def _node_names(args: Any) -> str | None:
    names = args.get("nodes") if isinstance(args, dict) else None
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        return None
    return "、".join(names) or None


__all__ = [
    "CAPABILITY_ID",
    "IMAGE_POLL_SECONDS",
    "IMAGE_WAIT_SECONDS",
    "MAX_IMAGES_PER_CALL",
    "MAX_LISTED_PROBLEMS",
    "IclipStudio",
    "IclipStudioToolset",
]
