"""iClip Studio 能力：登记视频拆解、工程文件检查与生图三件工具。"""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar, Final

import structlog
from pydantic_ai import ModelRetry, ToolFailed
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film, image_status
from iclip.capabilities.iclip_studio.film.load import ConversationImages, load_film
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.iclip_studio.film.packages import IMAGE
from iclip.capabilities.iclip_studio.film.prompts import render_picture, render_storyboard
from iclip.capabilities.iclip_studio.ports import (
    BreakdownError,
    InvalidNodeImageRequest,
    NodeImageJob,
    NodeImageRequest,
    NodeImages,
    SharedBreakdowns,
)
from iclip.common.shot_prompt import format_shot_prompt
from iclip.common.urls import is_http_url
from iclip.domains.agents.public import AgentRunDeps
from iclip.harness.files import write_or_retry
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import Material, MaterialLedger
from iclip.platform.media.ffmpeg import MediaError
from iclip.platform.transcript.display import (
    MEDIA_GRID_VIEW,
    DisplayFn,
    GenericDisplay,
    ToolDisplayEntry,
    media_grid,
    tool_note,
    url_filename,
)

CAPABILITY_ID: Final = "iclip_studio"

BREAKDOWN_RETRIES: Final = 3
"""拆解遇到可以重试的失败时，让模型再调几次；每次都是一次新的付费拆解。"""

_logger = structlog.stdlib.get_logger(__name__)

MAX_LISTED_PROBLEMS: Final = 30
"""一次检查最多列出几条问题；再多的改完前面的再查。"""

MAX_IMAGES_PER_CALL: Final = 10
"""一次生图调用最多几个节点。"""

IMAGE_POLL_SECONDS: Final = 3.0
IMAGE_WAIT_SECONDS: Final = 900.0
"""等一张图多久查一次、最多等多久；到点只是不再等，后台那次生成不取消。"""

_DOC_DIR: Final = "references"
_STEM_CHARS: Final = 40
_UNSAFE_STEM: Final = re.compile(r"[^A-Za-z0-9._-]+")


def breakdown_doc_path(video_url: str) -> str:
    """这条视频的拆解文档在工作区的路径；哈希后缀让同名的两条视频各有一份。"""

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


@dataclass
class IclipStudio(AbstractCapability[AgentDepsT]):
    """导演流程用的工具集。"""

    REQUIRES: ClassVar[tuple[str, ...]] = ("workspace",)
    """写下的文件经 workspace 的文件工具读取。"""

    space: FileSpace
    """与工作区能力相同的 FileSpace。"""

    breakdown: VideoBreakdown

    shared: SharedBreakdowns

    ledger: MaterialLedger
    """对话素材台账：用户给的图片地址在里面，生成出来的图也登记进去。"""

    images: NodeImages | None = None
    """生图节点与生成记录的往来；没开媒体生成时为 None。"""

    can_generate: bool = False
    """登不登记生图工具；不登记时检查照常。组合根现在不开：生图由人自己做。"""

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> IclipStudioToolset[AgentDepsT]:
        return IclipStudioToolset(self)

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """供组合根合并的工具卡声明。"""

        return {
            "breakdown_video": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
            "check_film": lambda args: GenericDisplay(summary="检查工程", detail=FILM_PATH),
            "generate_images": ToolDisplayEntry(
                draw=lambda args: GenericDisplay(summary="生成图片", detail=_node_names(args)),
                view=MEDIA_GRID_VIEW,
            ),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


class IclipStudioToolset(FunctionToolset[AgentDepsT]):
    """参数的范围规则挂在登记处的验证器上。"""

    def __init__(self, capability: IclipStudio[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.breakdown_video,
                name="breakdown_video",
                max_retries=BREAKDOWN_RETRIES,
                args_validator=self._validate_video_url,
            )
        )
        self.add_function(self.check_film, name="check_film")
        if capability.images is not None and capability.can_generate:
            self.add_function(self.generate_images, name="generate_images")

    async def breakdown_video(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解输入视频，返回结构化拆解文档路径，文档中详细列出输入视频的出场元素、逐镜时间线和整片分析。

        Args:
            video_url: 输入提供的视频的 url。
        """

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        path = breakdown_doc_path(video_url)
        done = f"视频拆解完毕，文档在 {path}。"
        # 工作区里已有的那份可能被用户指正过，不能拿共享的原始结果盖掉。
        if await files.read(namespace, path) is not None:
            return done
        document = await self._cap.shared.get(video_url)
        fresh = document is None
        if document is None:
            try:
                document = await self._cap.breakdown.run(video_url)
            except MediaError as exc:
                _logger.warning("视频拆解失败，视频读不了", reason=str(exc))
                raise ToolFailed("拆解失败，视频无法打开，不要重试，告诉用户换一条视频。") from exc
            except BreakdownError as exc:
                # 重试次数由登记处的 max_retries 管；用完后改报终局失败，不让整次运行中止。
                retry = exc.retryable and not ctx.last_attempt
                _logger.warning("视频拆解失败，模型没给出可用文档", reason=str(exc), retry=retry)
                if retry:
                    raise ModelRetry("拆解失败，再调用一次。") from exc
                raise ToolFailed("拆解失败，不要重试，告诉用户稍后再试。") from exc
        if fresh:
            # 先存共用的那份：工作区写入被配额等原因退回时，重试能直接取到，不必再付一次拆解。
            await self._cap.shared.put(video_url, document)
        await write_or_retry(files, namespace, path, document)
        return done

    async def check_film(
        self, ctx: RunContext[AgentDepsT], show: str | None = None
    ) -> ToolReturn[str]:
        """检查工程文件 film.icml 和运行文件 film.icrun，返回全部问题，或通过后的概况。

        每次改完这两个文件都调用一次，按返回的问题改到通过；问题带文件名和行号。通过时列出每个
        生图节点现在用哪张图。重复调用不花钱。

        Args:
            show: 检查通过后另外输出这个生图节点或视频节点拼好的提示词，写节点的名字；不需要
                时不传。
        """

        film = await self._load(ctx)
        if isinstance(film, list):
            return _problems(film)
        project = film.project
        videos = project.find("ReferenceVideo")
        status = image_status(film)
        lines = [f"检查通过：{len(status)} 个生图节点，{len(videos)} 次视频请求。"]
        lines += [f"{item.name}：{item.source}" for item in status]
        lines += [f"提示：{hint}" for hint in film.hints]
        if show is not None:
            node = project.nodes.get(show)
            tag = project.tags.get(node.tag) if node is not None else None
            if node is None or tag is None or tag.generation is None:
                names = "、".join(n.attrs["id"] for n in [*film.image_nodes(), *videos])
                raise ModelRetry(f"show 要写生图节点或视频节点的名字，可以写：{names}。")
            lines += ["", *_assembled(film, node)]
        return ToolReturn(return_value="\n".join(lines), metadata=tool_note(chip="通过"))

    async def generate_images(
        self, ctx: RunContext[AgentDepsT], nodes: list[str]
    ) -> ToolReturn[str]:
        """生成 film.icml 里指定的生图节点，每个节点出一张图，返回每张图的地址。

        只在用户说了要生成哪些图时调用。每调用一次，列出的每个节点都重新生成并计费；已经生成
        过、用户没有要求重做的不要再列。一次最多 10 个节点，更多的分几次调用。生成前先做与
        check_film 相同的检查，有问题不生成。运行文件里选用了登记图的节点不生成；一张失败
        不影响其它张，失败的在结果里说明，不要自动重试。

        Args:
            nodes: 要生成的生图节点的名字，如 ``["短发女生参考图", "镜01机位图"]``。
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
        pending = [name for name in targets if name not in film.selected]
        for name in targets:
            if name in film.selected:
                outcome[name] = (
                    f"没有生成，运行文件里选用了「{film.selected[name]}」；要重新生成先删掉它的 use"
                )
        deps = _deps(ctx)
        namespace = self._cap.space.resolve(ctx)
        while pending:
            # 一张图引用了这次也要生成的另一张，就等那一张先出来；互不相干的一起生成。
            ready = [name for name in pending if not _waits_for(film, known[name]) & set(pending)]
            results = await asyncio.gather(
                *(self._generate(images, deps, film, known[name]) for name in ready)
            )
            for name, (job, missing) in zip(ready, results, strict=True):
                pending.remove(name)
                if job.status == "completed" and job.output_url:
                    film.generated[name] = job.output_url
                    made.append((job.output_url, name))
                    note = f"；{'、'.join(missing)} 还没有图，这次只用了文字" if missing else ""
                    outcome[name] = f"已生成，地址 {job.output_url}{note}"
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
    ) -> tuple[NodeImageJob, list[str]]:
        """给一个节点出一张图并等它出结果；返回 (结果, 它引用的、现在还没有图的节点名)。"""

        project = film.project
        reference = node.reference("prompt")
        assert reference is not None
        picture = render_picture(film, project.nodes[reference])
        missing = sorted(
            name for name in _referenced_images(film, node) if film.image_url(name) is None
        )
        tag = project.declared(node)
        assert tag.generation is not None
        try:
            job = await images.submit(
                deps.principal,
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
            return NodeImageJob(
                uuid.UUID(int=0), "failed", error_message=f"请求被拒：{exc}"
            ), missing
        loop = asyncio.get_running_loop()
        deadline = loop.time() + IMAGE_WAIT_SECONDS
        while not job.finished:
            if loop.time() >= deadline:
                return (
                    NodeImageJob(
                        job.job_id,
                        "failed",
                        error_message="等超时了；它可能还在后台跑，稍后用 check_film 看这个节点有没有图",
                    ),
                    missing,
                )
            await asyncio.sleep(IMAGE_POLL_SECONDS)
            job = await images.get(deps.principal, job.job_id)
        return job, missing

    async def _load(self, ctx: RunContext[AgentDepsT]) -> Film | list[str]:
        """读两个文件并检查，再查出每个生图节点最近一次生成的图；通过时返回 ``Film``，否则返回问题。"""

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        project = await files.read(namespace, FILM_PATH)
        if project is None:
            raise ModelRetry(f"工作区里没有 {FILM_PATH}；先按规范把它写出来。")
        run = await files.read(namespace, RUN_PATH)
        deps = _deps(ctx)
        return await load_film(
            project.content,
            None if run is None else run.content,
            images=ConversationImages(
                ledger=self._cap.ledger,
                namespace=namespace,
                images=self._cap.images,
                principal=deps.principal,
                conversation_id=deps.conversation_id,
            ),
        )

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        _ = ctx
        if not is_http_url(video_url):
            raise ModelRetry("视频地址不对，输入提供的视频的 url。")


def _problems(problems: list[str]) -> ToolReturn[str]:
    listed = problems[:MAX_LISTED_PROBLEMS]
    lines = [f"检查没通过，共 {len(problems)} 处问题：", *listed]
    if len(problems) > len(listed):
        lines.append(f"只列了前 {len(listed)} 处，改完再检查。")
    return ToolReturn(
        return_value="\n".join(lines), metadata=tool_note(chip=f"{len(problems)} 处问题")
    )


def _assembled(film: Film, node: Node) -> list[str]:
    """一个生成节点拼好的提示词，连同发给模型的参数和参考图。"""

    project = film.project
    reference = node.reference("prompt")
    assert reference is not None
    prompt = project.nodes[reference]
    name = node.attrs["id"]
    if project.declared(node).output == ("image", IMAGE):
        picture = render_picture(film, prompt)
        head = f"{name}：画幅 {node.attrs['aspect-ratio']}，分辨率 {node.attrs['resolution']}"
        text, images, mark = picture.text, picture.image_urls, "图"
    else:
        group = render_storyboard(film, prompt)
        head = f"{name}：{group.seconds} 秒，画幅 {node.attrs['aspect-ratio']}"
        text, images, mark = format_shot_prompt(group), group.image_urls, "@Image"
    references = "、".join(f"{mark}{n} = {url}" for n, url in enumerate(images, start=1)) or "无"
    return [head, f"参考图：{references}", "", text]


def _referenced_images(film: Film, node: Node) -> set[str]:
    """一个生图节点的提示词里引用了哪些生图节点的图。"""

    project = film.project
    reference = node.reference("prompt")
    assert reference is not None
    image_nodes = {item.attrs["id"] for item in film.image_nodes()}
    names = {
        image.partition(".")[0]
        for child in project.nodes[reference].children
        if (image := child.reference("image")) is not None
    }
    return names & image_nodes


def _waits_for(film: Film, node: Node) -> set[str]:
    return _referenced_images(film, node) - {node.attrs["id"]}


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


def _video_name(args: Any) -> str | None:
    """工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = [
    "CAPABILITY_ID",
    "IMAGE_POLL_SECONDS",
    "IMAGE_WAIT_SECONDS",
    "MAX_IMAGES_PER_CALL",
    "MAX_LISTED_PROBLEMS",
    "IclipStudio",
    "IclipStudioToolset",
    "breakdown_doc_path",
]
