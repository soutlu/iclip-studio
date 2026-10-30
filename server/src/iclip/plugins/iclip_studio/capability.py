"""iClip Studio 插件：登记工程文件检查与生图两件工具。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import Material, MaterialLedger
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

from iclip.common.shot_prompt import format_shot_prompt
from iclip.plugins.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.plugins.iclip_studio.film.load import ConversationImages, load_film
from iclip.plugins.iclip_studio.film.markup import Node
from iclip.plugins.iclip_studio.film.packages import IMAGE
from iclip.plugins.iclip_studio.film.prompts import render_picture, render_video
from iclip.plugins.iclip_studio.ports import (
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
    NodeImages,
)

CAPABILITY_ID: Final = "iclip_studio"

MAX_LISTED_PROBLEMS: Final = 30
"""一次检查最多列出几条问题；再多的改完前面的再查。"""

MAX_IMAGES_PER_CALL: Final = 10
"""一次生图调用最多几个节点。"""

IMAGE_POLL_SECONDS: Final = 3.0
IMAGE_WAIT_SECONDS: Final = 900.0
"""等一张图多久查一次、最多等多久；到点只是不再等，后台那次生成不取消。"""


@dataclass
class IclipStudio(CapPlugin[AgentDepsT]):
    """导演工程插件。"""

    label = "导演工程"
    summary = "检查 AI 导演的工程文件和运行文件是否符合规范。"

    space: FileSpace
    """与工作区能力相同的 FileSpace。"""

    ledger: MaterialLedger
    """对话素材台账：用户给的图片地址在里面，生成出来的图也登记进去。"""

    images: NodeImages | None = None
    """生图节点与生成记录的往来；没开媒体生成时为 None。"""

    can_generate: bool = False
    """登不登记生图工具；不登记时检查照常。组合根现在不开：生图由人自己做。"""

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> IclipStudioToolset[AgentDepsT]:
        return IclipStudioToolset(self)

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(
        cls, *, space: FileSpace, ledger: MaterialLedger, images: NodeImages | None
    ) -> type[Self]:
        """把运行服务绑进类，交给登记表。"""

        return cls._bound(space=space, ledger=ledger, images=images)

    @classmethod
    def from_spec(cls) -> Self:
        # 现阶段生图由人自己做：生图工具保留，不登记给 agent（can_generate 用默认的 False）。
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        # 检查的两个文件由 workspace 的文件工具读写。
        return CapabilityOrdering(requires=(Workspace,))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """工具卡声明。"""

        return {
            "check_film": lambda args: GenericDisplay(summary="检查工程", detail=FILM_PATH),
            "generate_images": ToolDisplayEntry(
                draw=lambda args: GenericDisplay(summary="生成图片", detail=_node_names(args)),
                view=MEDIA_GRID_VIEW,
            ),
        }


class IclipStudioToolset(FunctionToolset[AgentDepsT]):
    """检查与生图两件工具；生图只在有生图端口且允许生成时登记。"""

    def __init__(self, capability: IclipStudio[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_function(self.check_film, name="check_film")
        if capability.images is not None and capability.can_generate:
            self.add_function(self.generate_images, name="generate_images")

    async def check_film(
        self, ctx: RunContext[AgentDepsT], show: str | None = None
    ) -> ToolReturn[str]:
        """检查工程文件 film.icml 和运行文件 film.icrun 是否符合工程规范，包括文件结构、引用关系、
        参数和素材来源。

        检查分阶段进行，返回本次发现的问题及文件位置，每次最多列出 30 处。修正后重新检查。
        图片尚未选用不影响工程规范检查；可用 show 查看指定节点的最终提示词、参考图和缺图情况。

        Args:
            show: 填写 film.icml 中图片或视频生成节点的 id，如“镜02机位图”“全片”。工程规范
                检查通过后，返回该节点的最终提示词、参考图地址及尚未选用的参考图。
        """

        film = await self._load(ctx)
        if isinstance(film, list):
            return _problems(film)
        project = film.project
        videos = project.find("ReferenceVideo")
        lines = [
            f"工程规范检查通过：{len(film.image_nodes())} 个图片生成节点，{len(videos)} 个视频生成节点。"
        ]
        if show is not None:
            node = project.nodes.get(show)
            tag = project.tags.get(node.tag) if node is not None else None
            if node is None or tag is None or tag.generation is None:
                names = "、".join(n.attrs["id"] for n in [*film.image_nodes(), *videos])
                raise ModelRetry(f"show 要填某张图或某段视频的 id，可以填：{names}。")
            lines += ["", *_assembled(film, node)]
        return ToolReturn(return_value="\n".join(lines), metadata=tool_note(chip="通过"))

    async def generate_images(
        self, ctx: RunContext[AgentDepsT], nodes: list[str]
    ) -> ToolReturn[str]:
        """生成 film.icml 里指定的生图节点，每个节点出一张图，返回每张图的地址。

        只在用户说了要生成哪些图时调用。每调用一次，列出的每个节点都重新生成并计费；已经生成
        过、用户没有要求重做的不要再列。一次最多 10 个节点，更多的分几次调用。生成前先做与
        check_film 相同的检查，有问题不生成。运行文件里选用了登记图的节点不生成；挂的参考图里
        有还没选用的，这个节点不生成，结果里列出缺哪几张，等用户在制作页选用后再生成。一张失败
        不影响其它张，失败的在结果里说明，不要自动重试。生成出来的图不会自动用上，用户在制作页
        选用了才算有图。

        Args:
            nodes: 要生成的生图节点的名字，如 ``["短发女生设定图", "镜01机位图"]``。
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
        deps = _deps(ctx)
        namespace = self._cap.space.resolve(ctx)
        # 生成出来的图要用户选用才算有图，同一次里先出的也不给后出的当参考，所以一起生成。
        results = await asyncio.gather(
            *(self._generate(images, deps, film, known[name]) for name in pending)
        )
        for name, job in zip(pending, results, strict=True):
            if job.status == "completed" and job.output_url:
                made.append((job.output_url, name))
                outcome[name] = f"已生成，地址 {job.output_url}"
            else:
                outcome[name] = f"生成失败，{job.error_message or '没有说明原因'}"
        await self._cap.ledger.record(
            namespace, [Material(url=url, kind="image") for url, _ in made]
        )
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
        """给一个参考图都有图的节点出一张图并等它出结果。"""

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
        """读两个文件并检查；通过时返回 ``Film``，否则返回问题。"""

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        project = await files.read(namespace, FILM_PATH)
        if project is None:
            raise ModelRetry(f"工作区里没有 {FILM_PATH}；先按规范把它写出来。")
        run = await files.read(namespace, RUN_PATH)
        return await load_film(
            project.content,
            None if run is None else run.content,
            images=ConversationImages(ledger=self._cap.ledger, namespace=namespace),
        )


def _problems(problems: list[str]) -> ToolReturn[str]:
    listed = problems[:MAX_LISTED_PROBLEMS]
    lines = [f"工程规范检查未通过，本次发现 {len(problems)} 处问题：", *listed]
    if len(problems) > len(listed):
        lines.append(f"仅列出前 {len(listed)} 处，修正后重新检查。")
    return ToolReturn(
        return_value="\n".join(lines), metadata=tool_note(chip=f"{len(problems)} 处问题")
    )


def _assembled(film: Film, node: Node) -> list[str]:
    """一个生成节点拼好的提示词，连同发给模型的参数和参考图。"""

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
            f"@Image{n} = {item.url or f'{item.image}（尚未选用图片）'}"
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
    """工具卡展示要生成的节点。"""

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
