"""iClip Studio 能力：登记视频拆解、工程文件检查与分镜导出三件工具。"""

from __future__ import annotations

import hashlib
import re
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
from iclip.capabilities.iclip_studio.film.checks import check
from iclip.capabilities.iclip_studio.film.export import NothingToExport, export_shots, image_status
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH, Film
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.iclip_studio.film.packages import GPT_IMAGE_SIZES, IMAGE
from iclip.capabilities.iclip_studio.film.prompts import render_picture, render_storyboard
from iclip.capabilities.iclip_studio.ports import BreakdownError, SharedBreakdowns
from iclip.capabilities.shot_document import (
    SHOTS_PATH,
    ShotDocumentError,
    validate_video_shot_requests,
)
from iclip.common.shot_prompt import format_shot_prompt
from iclip.common.urls import is_http_url
from iclip.harness.files import write_or_retry
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.media.ffmpeg import MediaError
from iclip.platform.transcript.display import DisplayFn, GenericDisplay, tool_note, url_filename

CAPABILITY_ID: Final = "iclip_studio"

BREAKDOWN_RETRIES: Final = 3
"""拆解遇到可以重试的失败时，让模型再调几次；每次都是一次新的付费拆解。"""

_logger = structlog.stdlib.get_logger(__name__)

MAX_LISTED_PROBLEMS: Final = 30
"""一次检查最多列出几条问题；再多的改完前面的再查。"""

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
    """对话素材台账：工程文件和运行文件里写的图片地址要在里面。"""

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> IclipStudioToolset[AgentDepsT]:
        return IclipStudioToolset(self)

    def display_table(self) -> Mapping[str, DisplayFn]:
        """供组合根合并的工具卡声明。"""

        return {
            "breakdown_video": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
            "check_film": lambda args: GenericDisplay(summary="检查工程", detail=FILM_PATH),
            "export_shots": lambda args: GenericDisplay(summary="导出分镜", detail=SHOTS_PATH),
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
        self.add_function(self.export_shots, name="export_shots")

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

    async def export_shots(self, ctx: RunContext[AgentDepsT]) -> ToolReturn[str]:
        """把 film.icml 里的视频节点导出成分镜文件 video_shot.json，整份覆盖原文件。

        导出前先做与 check_film 相同的检查，有问题不导出，先改到通过。每个视频节点导出成一个
        镜头组，只带上现在有图的参考图。
        """

        film = await self._load(ctx)
        if isinstance(film, list):
            listed = "\n".join(film[:MAX_LISTED_PROBLEMS])
            raise ModelRetry(f"检查没通过，没有导出。先改掉这 {len(film)} 处问题：\n{listed}")
        try:
            document = export_shots(film)
            validate_video_shot_requests(document.shots)
        except NothingToExport as exc:
            raise ModelRetry(f"{exc}；先在 {FILM_PATH} 里写出 Storyboard 和视频节点。") from exc
        except ShotDocumentError as exc:
            raise ModelRetry(f"导出的分镜不合格式：{exc}") from exc
        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        await write_or_retry(files, namespace, SHOTS_PATH, document.file_text())
        groups = len(document.shots)
        shots = sum(len(row.prompt.timeline) for row in document.shots)
        seconds = sum(row.seconds for row in document.shots)
        images = sum(len(row.image_urls) for row in document.shots)
        return ToolReturn(
            return_value=(
                f"已导出到 {SHOTS_PATH}：{groups} 个镜头组，{shots} 个镜头，合计 {seconds} 秒，"
                f"带 {images} 张参考图。"
            ),
            metadata=tool_note(chip=f"{groups} 组 · {shots} 镜 · {seconds} 秒"),
        )

    async def _load(self, ctx: RunContext[AgentDepsT]) -> Film | list[str]:
        """读两个文件并检查；通过时返回 ``Film``，否则返回问题。"""

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        project = await files.read(namespace, FILM_PATH)
        if project is None:
            raise ModelRetry(f"工作区里没有 {FILM_PATH}；先按规范把它写出来。")
        run = await files.read(namespace, RUN_PATH)
        film = check(project.content, None if run is None else run.content)
        if isinstance(film, list):
            return film
        if not film.errors:
            for document, node in film.given_images():
                recorded = await self._cap.ledger.lookup(namespace, node.attrs["src"])
                if recorded is None or recorded.kind != "image":
                    # 不回显地址：没被认可的地址不通过报错进模型上下文。
                    document.error(node, "src 不是这段对话里的图片；只能写对话里给出的图片地址")
                    if document is not film.project:
                        film.errors.append(document.errors[-1])
        return film.errors or film

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
        size = GPT_IMAGE_SIZES[(node.attrs["aspect-ratio"], node.attrs["resolution"])]
        head = f"{name}：画幅 {node.attrs['aspect-ratio']}，尺寸 {size}"
        text, images, mark = picture.text, picture.image_urls, "图"
    else:
        group = render_storyboard(film, prompt)
        head = f"{name}：{group.seconds} 秒，画幅 {node.attrs['aspect-ratio']}"
        text, images, mark = format_shot_prompt(group), group.image_urls, "@Image"
    references = "、".join(f"{mark}{n} = {url}" for n, url in enumerate(images, start=1)) or "无"
    return [head, f"参考图：{references}", "", text]


def _video_name(args: Any) -> str | None:
    """工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = [
    "CAPABILITY_ID",
    "MAX_LISTED_PROBLEMS",
    "IclipStudio",
    "IclipStudioToolset",
    "breakdown_doc_path",
]
