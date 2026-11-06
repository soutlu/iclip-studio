from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Annotated, Any

from agent_runtime.file_store.store import FileStore
from agent_runtime.harness.files import write_or_retry
from agent_runtime.harness.materials import require_http, require_media
from agent_runtime.run_deps import AgentRunDeps
from agent_runtime.tool_args import JsonText
from agent_runtime.transcript.display import media_grid
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip_video.shot_video.delivery import (
    FrameRequest,
    resolve_cells,
    resolve_requests,
)
from iclip_video.shot_video.extraction import EXTRACTION_PATH
from iclip_video.shot_video.generation import (
    ANCHOR_ASPECT,
    GRID_RESOLUTION,
    IMAGE_MODEL,
    job_failure,
)
from iclip_video.shot_video.ports import AnchorSheets, ImageRequest, ShotCells
from iclip_video.shot_video.prompt import assemble_anchor_prompt, assemble_grid_prompt
from iclip_video.shot_video.shots import CELL_ID_SHAPE
from iclip_video.video_document import video_doc_path

if TYPE_CHECKING:
    from iclip_video.shot_video.capability import ShotVideo


class ShotVideoToolset(FunctionToolset[AgentDepsT]):
    def __init__(self, capability: ShotVideo[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.plan_shot_frames,
                name="plan_shot_frames",
                args_validator=self._validate_video_url,
            )
        )
        self.add_tool(
            Tool(
                self.generate_shot_frames,
                name="generate_shot_frames",
                args_validator=self._validate_frame_generation,
            )
        )
        self.add_tool(Tool(self.generate_anchor_sheet, name="generate_anchor_sheet"))

    async def plan_shot_frames(
        self, ctx: RunContext[AgentDepsT], video_url: str
    ) -> ToolReturn[dict[str, Any]] | dict[str, Any]:
        """从参考视频抽帧，按结构层级组合成图片。

        Args:
            video_url: 参考视频地址。
        """

        files, namespace = self._workspace(ctx)
        doc_path = video_doc_path(video_url)
        rows = await self._cap.extractor.shot_rows(files, namespace, doc_path)
        document, reused = await self._cap.extractor.ledger(
            files, namespace, video_url=video_url, rows=rows
        )
        if not reused:
            await write_or_retry(
                files,
                namespace,
                EXTRACTION_PATH,
                document.model_dump_json(by_alias=True, indent=2),
            )

        boards = document.boards
        stray = sorted({board.board for board in boards if board.board > len(rows)})
        if stray:
            raise ModelRetry(
                f"取帧台账 {EXTRACTION_PATH} 里的板 {', '.join(map(str, stray))} 超出拆解文档的 "
                f"{len(rows)} 个结构层级。用 delete_file 删掉 {EXTRACTION_PATH} 后重新调用 "
                "plan_shot_frames。"
            )
        shots_of = {
            board.board: sorted({shot.shot_id for shot in rows[board.board - 1]})
            for board in boards
        }
        message = (
            f"取帧完成：共 {len(rows)} 个结构层级，组合成 {len(boards)} 组图片。"
            f"每组图中每张视频帧左上的标注即帧号（{CELL_ID_SHAPE}）。"
        )
        return ToolReturn(
            return_value={
                "message": message,
                "boards": [
                    {
                        "board": board.board,
                        "shots": shots_of[board.board],
                        "url": board.url,
                    }
                    for board in boards
                ],
            },
            metadata=media_grid(
                (
                    (
                        board.url,
                        f"板 {board.board} · {','.join(map(str, shots_of[board.board]))}",
                    )
                    for board in boards
                ),
                note=f"{len(boards)} 板",
            ),
        )

    async def generate_shot_frames(
        self,
        ctx: RunContext[AgentDepsT],
        frames: Annotated[list[FrameRequest], JsonText],
        reference_images: list[str],
        global_reference: str,
        target_aspect: str,
    ) -> ToolReturn[dict[str, Any]]:
        """按逐帧 visual_prompt 生成镜头帧，返回每帧的图片地址。

        工作区里还没有取帧台账时被拒，先对参考视频调用 plan_shot_frames。

        Args:
            frames: 逐格请求，1-4 条。
            reference_images: 参考图地址，顺序即 @Image1..N；逐字取自工具结果或对话。
            target_aspect: 目标画幅，如 ``9:16``。
            global_reference: 整段「全局参考设定」文本。
        """

        files, namespace = self._workspace(ctx)
        owner = _owner(ctx)
        if await self._cap.extractor.load(files, namespace) is None:
            raise ModelRetry("取帧账本不存在或版本不兼容，先调用 plan_shot_frames。")
        cell_ids, prompts = resolve_requests(frames)
        references = tuple(reference_images)
        try:
            prompt = assemble_grid_prompt(
                global_reference=global_reference,
                visual_prompts=prompts,
                target_aspect=target_aspect,
            )
        except ValueError as exc:
            raise ModelRetry(str(exc)) from exc

        job = await self._cap.generator.generate(
            owner,
            ImageRequest(
                prompt=prompt,
                model=IMAGE_MODEL,
                aspect_ratio=target_aspect,
                resolution=GRID_RESOLUTION,
                channel="dev",
                user_name=_user_name(ctx),
                reference_image_urls=references,
                conversation_id=_generation_conversation_id(ctx),
            ),
        )
        if job.status != "completed" or not job.output_url:
            job_failure(job, message="镜头帧生成失败。")
        cut = await self._cap.generator.cut(
            owner,
            job,
            cells=ShotCells(cell_ids=tuple(cell_ids)),
            aspect=target_aspect,
            failure_message="镜头帧处理失败。",
        )
        frames_payload = [
            {"no": cell_id, "url": url} for cell_id, url in zip(cell_ids, cut.urls, strict=True)
        ]
        return ToolReturn(
            return_value={"frames": frames_payload},
            metadata=media_grid(zip(cut.urls, cell_ids, strict=True)),
        )

    async def generate_anchor_sheet(
        self, ctx: RunContext[AgentDepsT], cells: list[str]
    ) -> ToolReturn[dict[str, Any]]:
        """按 prompt 生成设定图，一条描述一张图，返回逐张地址。

        Args:
            cells: 逐张描述，一张一个实体，1-4 条。
        """

        owner = _owner(ctx)
        descriptions = resolve_cells(cells)
        job = await self._cap.generator.generate(
            owner,
            ImageRequest(
                model=IMAGE_MODEL,
                prompt=assemble_anchor_prompt(cells=descriptions, target_aspect=ANCHOR_ASPECT),
                aspect_ratio=ANCHOR_ASPECT,
                resolution=GRID_RESOLUTION,
                channel="dev",
                user_name=_user_name(ctx),
                conversation_id=_generation_conversation_id(ctx),
            ),
        )
        if job.status != "completed" or not job.output_url:
            job_failure(job, message="设定图生成失败。")
        cut = await self._cap.generator.cut(
            owner,
            job,
            cells=AnchorSheets(indexes=tuple(range(1, len(descriptions) + 1))),
            aspect=None,
            failure_message="设定图处理失败。",
        )
        images = [{"index": index, "url": url} for index, url in enumerate(cut.urls, start=1)]
        return ToolReturn(
            return_value={"images": images},
            metadata=media_grid(zip(cut.urls, descriptions, strict=True), note=f"{len(images)} 格"),
        )

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        _ = ctx
        require_http(video_url, what="视频地址")

    async def _validate_frame_generation(
        self,
        ctx: RunContext[Any],
        frames: list[FrameRequest],
        reference_images: list[str],
        global_reference: str,
        target_aspect: str,
    ) -> None:
        _ = (ctx, frames, global_reference, target_aspect)
        await require_media(
            [(f"@Image{n}", url) for n, url in enumerate(reference_images, start=1)],
            kind="image",
            what="参考图地址",
        )

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        return self._cap.space.store, self._cap.space.resolve(ctx)


def _generation_conversation_id(ctx: RunContext[AgentDepsT]) -> str | None:
    deps = _deps(ctx)
    conversation_id = deps.conversation_id
    try:
        uuid.UUID(conversation_id)
    except ValueError as exc:
        raise RuntimeError("这次运行的对话 id 不是 UUID——运行状态已损坏。") from exc
    return None if deps.preview else conversation_id


def _owner(ctx: RunContext[AgentDepsT]) -> uuid.UUID:
    return _deps(ctx).user_id


def _user_name(ctx: RunContext[AgentDepsT]) -> str:
    return _deps(ctx).user_name


def _deps(ctx: RunContext[AgentDepsT]) -> AgentRunDeps:
    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"这次运行的 deps 是 {type(deps).__name__}，不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return deps


__all__ = ["ShotVideoToolset"]
