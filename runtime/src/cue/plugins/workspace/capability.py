from __future__ import annotations

import difflib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Annotated, Any, Final, Literal, Self

import structlog
from pydantic import BaseModel, Field
from pydantic_ai import ModelRetry
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.messages import ImageUrl, ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import AgentToolset, FunctionToolset

from cue.file_store.store import (
    FileEntry,
    FileSpace,
    InvalidPath,
    normalize_path,
)
from cue.harness.files import write_or_retry
from cue.harness.materials import require_http
from cue.harness.media import (
    IMAGE_CONTEXT_MAX_EDGE,
    cropped_image_url,
    media_tag_close,
    media_tag_open,
    resized_image_url,
)
from cue.plugins.base import CapPlugin
from cue.plugins.workspace.ports import ImageInfo, MediaProbe, MediaProbeFailed
from cue.tool_args import JsonText
from cue.transcript.display import (
    FILE_CONTENT_VIEW,
    MEDIA_GRID_VIEW,
    SEARCH_RESULTS_VIEW,
    DisplayFn,
    FileIoDisplay,
    GenericDisplay,
    SearchDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    diff_note,
    file_content,
    media_grid,
    search_results,
    tool_note,
)

_logger = structlog.stdlib.get_logger(__name__)

CAPABILITY_ID: Final = "workspace"

MAX_READ_LINES: Final = 400
MAX_READ_CHARS: Final = 50_000

_READ_NOTE_RESERVE: Final = 200

MAX_SEARCH_RESULTS: Final = 50

FULL_RESOLUTION_MAX_BYTES: Final = 10 * 1024 * 1024

_GUIDANCE = "这段对话有一个持久的工作目录，你和你派出去的下属共用同一个根，所有路径都相对它。"


@dataclass
class Workspace(CapPlugin[AgentDepsT]):
    label = "工作区文件"
    summary = "查看、搜索、读写、移动和删除对话工作区里的文件，也能查看图片。"

    space: FileSpace

    probe: MediaProbe

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    _scope: str | None = field(default=None, init=False, repr=False, compare=False)

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> Workspace[AgentDepsT]:
        clone = replace(self)
        clone._scope = clone._resolve_scope(ctx)
        return clone

    def resolve_scope(self, ctx: RunContext[AgentDepsT]) -> str:

        if self._scope is not None:
            return self._scope
        return self._resolve_scope(ctx)

    def _resolve_scope(self, ctx: RunContext[AgentDepsT]) -> str:
        return self.space.resolve(ctx)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return WorkspaceToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        return _GUIDANCE

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(cls, *, space: FileSpace, probe: MediaProbe) -> type[Self]:
        return cls._bound(space=space, probe=probe)

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {
            "read_file": ToolDisplayEntry(
                draw=lambda args: _file_io("read", _text(args, "path")), view=FILE_CONTENT_VIEW
            ),
            "write_file": lambda args: _file_io(
                "write", _text(args, "path"), content=_text(args, "content")
            ),
            "edit_file": lambda args: _file_io(
                "edit",
                _text(args, "path"),
                before=_text(args, "old_text"),
                after=_text(args, "new_text"),
            ),
            "list_files": lambda args: _file_io("glob", _text(args, "prefix") or "/"),
            "delete_file": _delete_display,
            "move_file": _move_display,
            "search_files": ToolDisplayEntry(draw=_search_display, view=SEARCH_RESULTS_VIEW),
            "ReadMediaFile": ToolDisplayEntry(draw=_media_display, view=MEDIA_GRID_VIEW),
        }


def _text(args: Any, field_name: str) -> str | None:

    if isinstance(args, dict):
        value = args.get(field_name)
        if isinstance(value, str) and value:
            return value
    return None


def _file_io(
    operation: Literal["read", "write", "edit", "glob", "grep"],
    path: str | None,
    *,
    content: str | None = None,
    before: str | None = None,
    after: str | None = None,
) -> ToolDisplay | None:
    if path is None:
        return None
    return FileIoDisplay(
        operation=operation, path=path, content=content, before=before, after=after
    )


def _delete_display(args: Any) -> ToolDisplay | None:
    path = _text(args, "path")
    return None if path is None else GenericDisplay(summary="删除文件", detail=path)


def _move_display(args: Any) -> ToolDisplay | None:
    source = _text(args, "source")
    destination = _text(args, "destination")
    if source is None or destination is None:
        return None
    return GenericDisplay(summary="移动文件", detail=f"{source} → {destination}")


def _search_display(args: Any) -> ToolDisplay | None:
    query = _text(args, "query")
    return None if query is None else SearchDisplay(query=query)


def _media_display(args: Any) -> ToolDisplay | None:
    url = _text(args, "url")
    return None if url is None else GenericDisplay(summary="读取图片")


def _size_chip(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    return _bytes_label(size_bytes)


def _diff_counts(old_text: str, new_text: str) -> tuple[int, int]:
    added = removed = 0
    for line in difflib.unified_diff(old_text.splitlines(), new_text.splitlines(), n=0):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def _numbered_rows(
    window: Sequence[str], *, first: int, budget: int
) -> tuple[list[str], int | None]:
    rows: list[str] = []
    used = 0
    for number, line in enumerate(window, start=first):
        row = f"{number:>6}\t{line}"
        cost = len(row) + (1 if rows else 0)
        if used + cost > budget:
            if rows:
                return rows, None
            return [row[:budget]], budget - (len(row) - len(line))
        rows.append(row)
        used += cost
    return rows, None


def _bytes_label(size_bytes: int) -> str:

    mib = 1024 * 1024
    if size_bytes >= mib:
        return f"{size_bytes / mib:.1f} MB"
    return f"{size_bytes / 1024:.1f} KB"


def _checked(path: str) -> str:
    try:
        return normalize_path(path)
    except InvalidPath as exc:
        raise ModelRetry(str(exc)) from exc


class CropRegion(BaseModel):
    """A crop rectangle in original-image pixel coordinates."""

    x: int = Field(ge=0, description="Left edge of the crop, in original-image pixels.")
    y: int = Field(ge=0, description="Top edge of the crop, in original-image pixels.")
    width: int = Field(ge=1, description="Crop width, in original-image pixels.")
    height: int = Field(ge=1, description="Crop height, in original-image pixels.")


class WorkspaceToolset(FunctionToolset[AgentDepsT]):
    def __init__(self, capability: Workspace[AgentDepsT]) -> None:
        super().__init__(id=CAPABILITY_ID)
        self._capability = capability
        self.add_function(self.read_file, name="read_file")
        self.add_function(self.write_file, name="write_file", sequential=True)
        self.add_function(self.edit_file, name="edit_file", sequential=True)
        self.add_function(self.delete_file, name="delete_file", sequential=True)
        self.add_function(self.move_file, name="move_file", sequential=True)
        self.add_function(self.list_files, name="list_files")
        self.add_function(self.search_files, name="search_files")
        self.add_tool(
            Tool(
                self.read_media_file,
                name="ReadMediaFile",
                args_validator=self._validate_image_url,
            )
        )

    async def _validate_image_url(
        self,
        ctx: RunContext[Any],
        url: str,
        region: CropRegion | None = None,
        full_resolution: bool = False,
    ) -> None:
        _ = (ctx, region, full_resolution)
        require_http(url, what="图片地址")

    async def read_file(
        self, ctx: RunContext[AgentDepsT], path: str, offset: int = 1, limit: int = MAX_READ_LINES
    ) -> ToolReturn[str]:
        """Read the contents of a file with line numbers.

        Supports pagination via offset and limit for large files; always read a
        file before editing it to understand its current contents. Output is
        truncated at a line boundary if it exceeds 400 lines or 50,000 characters,
        with a trailing note showing remaining lines and the next offset (if a
        single line exceeds 50,000 characters, only its prefix is returned).

        Args:
            path: Path to the file in the workspace.
            offset: Line number to start reading from (1-indexed).
            limit: Maximum number of lines to read (up to 400).
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        stored = await self._capability.space.store.read(scope, key)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {key!r}。用 list_files 看看有哪些文件。")
        if offset < 1:
            raise ModelRetry("offset 从 1 起算。")
        capped = min(limit, MAX_READ_LINES)
        lines = stored.content.splitlines()
        window = lines[offset - 1 : offset - 1 + capped]
        if not window:
            raise ModelRetry(f"{key!r} 只有 {len(lines)} 行，读不到第 {offset} 行。")
        rows, kept = _numbered_rows(
            window, first=offset, budget=MAX_READ_CHARS - _READ_NOTE_RESERVE
        )
        notes: list[str] = []
        if kept is not None:
            notes.append(
                f"[第 {offset} 行有 {len(window[0])} 字符，放不进单次 {MAX_READ_CHARS:,} 字符的返回上限，"
                f"只给了前 {kept} 个；这一行其余部分 read_file 读不到]"
            )
        read_to = offset - 1 + len(rows)
        remaining = len(lines) - read_to
        if remaining > 0:
            reason = f"单次最多 {MAX_READ_CHARS:,} 字符，" if len(rows) < len(window) else ""
            notes.append(f"[{reason}还有 {remaining} 行没读，用 offset={read_to + 1} 接着读]")
        return ToolReturn(
            return_value="\n".join([*rows, *notes]),
            metadata=file_content(
                key, lines=len(rows), truncated=remaining > 0 or kept is not None
            ),
        )

    async def write_file(
        self, ctx: RunContext[AgentDepsT], path: str, content: str
    ) -> ToolReturn[str]:
        """Create or overwrite a file with the given contents.

        Use this for creating new files or replacing an entire file. For modifying
        existing files, prefer edit_file (which includes concurrency protection)
        so prior changes are not overwritten. Text content only; do not write
        binary image, audio, or video data.

        Args:
            path: Path to the file in the workspace.
            content: The full text content to write to the file.
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        entry = await self._write(scope, key, content)
        return ToolReturn(
            return_value=f"已写入 {entry.path}（{entry.size_bytes} 字节）",
            metadata=tool_note(chip=_size_chip(entry.size_bytes)),
        )

    async def edit_file(
        self, ctx: RunContext[AgentDepsT], path: str, old_text: str, new_text: str
    ) -> ToolReturn[str]:
        """Edit a file by replacing an exact text match with new text.

        The old_text must match exactly one location in the file, including
        whitespace and indentation. If it matches zero or multiple locations, the
        edit is rejected with an error message. Include enough surrounding context
        in old_text to ensure a unique match. Prefer small, focused edits over
        rewriting entire files.

        Args:
            path: Path to the file in the workspace.
            old_text: The exact text to find and replace. Must match uniquely.
            new_text: The text to replace old_text with (empty string to delete).
        """

        key = _checked(path)
        if not old_text:
            raise ModelRetry("old_text 不能为空；要新建或整份覆盖就用 write_file。")
        scope = self._capability.resolve_scope(ctx)
        stored = await self._capability.space.store.read(scope, key)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {key!r}。要新建就用 write_file。")
        occurrences = stored.content.count(old_text)
        if occurrences == 0:
            raise ModelRetry(
                f"{key!r} 里找不到这段原文。先用 read_file 看一眼实际内容再改（空白和标点要照抄）。"
            )
        if occurrences > 1:
            raise ModelRetry(
                f"这段原文在 {key!r} 里出现了 {occurrences} 次，不知道该改哪一处。"
                "把上下文多带几行进 old_text，让它唯一。"
            )
        entry = await self._write(
            scope, key, stored.content.replace(old_text, new_text), expected_version=stored.version
        )
        return ToolReturn(
            return_value=f"已改 {entry.path}（现在 {entry.size_bytes} 字节）",
            metadata=diff_note(*_diff_counts(old_text, new_text)),
        )

    async def delete_file(self, ctx: RunContext[AgentDepsT], path: str) -> str:
        """Delete a file from the workspace.

        Args:
            path: Path to the file to delete.
        """

        key = _checked(path)
        scope = self._capability.resolve_scope(ctx)
        if not await self._capability.space.store.delete(scope, key):
            raise ModelRetry(f"工作区里没有 {key!r}，无从删除。")
        return f"已删除 {key}"

    async def move_file(self, ctx: RunContext[AgentDepsT], source: str, destination: str) -> str:
        """Move or rename a file in the workspace without changing its contents.

        Rejected if destination already exists; delete destination with delete_file
        first when replacing an existing file.

        Args:
            source: Current file path.
            destination: New file path.
        """

        src = _checked(source)
        dst = _checked(destination)
        if src == dst:
            raise ModelRetry(
                f"source 和 destination 都是 {src!r}，不用移；改名就给一个不同的 destination。"
            )
        scope = self._capability.resolve_scope(ctx)
        store = self._capability.space.store
        stored = await store.read(scope, src)
        if stored is None:
            raise ModelRetry(f"工作区里没有 {src!r}，无从移动。用 list_files 看看有哪些文件。")
        if await store.read(scope, dst) is not None:
            raise ModelRetry(
                f"{dst!r} 已经存在，不会覆盖。确实要替换它，先用 delete_file 删掉 {dst!r} 再移。"
            )
        entry = await self._write(scope, dst, stored.content)
        await store.delete(scope, src)
        return f"已把 {src} 移到 {entry.path}"

    async def list_files(self, ctx: RunContext[AgentDepsT], prefix: str = "") -> ToolReturn[str]:
        """List files in the workspace with their sizes in bytes.

        Args:
            prefix: Directory prefix to filter by (empty for all files).
        """

        scope = self._capability.resolve_scope(ctx)
        entries = await self._entries(scope, prefix)
        if not entries:
            where = "工作区" if not prefix else f"{prefix!r} 下"
            return ToolReturn(
                return_value=f"{where}还没有任何文件。", metadata=tool_note(chip="0 个文件")
            )
        return ToolReturn(
            return_value="\n".join(f"{entry.path}\t{entry.size_bytes} 字节" for entry in entries),
            metadata=tool_note(chip=f"{len(entries)} 个文件"),
        )

    async def search_files(
        self, ctx: RunContext[AgentDepsT], query: str, limit: int = 20
    ) -> ToolReturn[str]:
        """Search file contents in the workspace for a literal text query.

        Returns matching lines with file paths and line numbers. Case-insensitive
        literal match (not regex). At most a few matches are reported per file.

        Args:
            query: Literal text to search for.
            limit: Maximum number of matches to return (up to 50).
        """

        if not query:
            raise ModelRetry("要检索的文本不能为空。")
        scope = self._capability.resolve_scope(ctx)
        result = await self._capability.space.store.search(
            scope, query, limit=min(limit, MAX_SEARCH_RESULTS)
        )
        hits = search_results(
            query,
            ((match.path, match.line, match.snippet) for match in result.matches),
            truncated=result.truncated,
        )
        if not result.matches:
            return ToolReturn(return_value=f"工作区里没有包含 {query!r} 的内容。", metadata=hits)
        lines = [f"{match.path}:{match.line}\t{match.snippet}" for match in result.matches]
        if result.truncated:
            lines.append("[命中较多，只报了一部分；把检索词写得更具体一些]")
        return ToolReturn(return_value="\n".join(lines), metadata=hits)

    async def read_media_file(
        self,
        ctx: RunContext[AgentDepsT],
        url: str,
        region: Annotated[CropRegion | None, JsonText] = None,
        full_resolution: bool = False,
    ) -> ToolReturn:
        """Read an image from a URL and attach its content as multimodal input.

        - Call this tool in parallel within a single response when inspecting multiple
          images; do not read them one by one across turns.
        - Do not re-read images that have already been read and are still in context.
        - Supports image files only. Read the breakdown document for video information,
          and use `read_file` for text and artifact files.
        - Downsampled to a maximum longest edge of 1024px by default (attached as-is if
          already ≤ 1024px). To inspect small text or fine detail, pass `region` in
          original-image pixel coordinates; pass `full_resolution=True` only when the
          entire image must be viewed at native resolution.
        - `region` and `full_resolution` are mutually exclusive; passing both is rejected.
        - `full_resolution` is rejected when the original image exceeds 10 MB; use
          `region` to inspect sections instead.
        - The result begins with the original dimensions, format, byte size, and
          delivery mode. Always compute output coordinates against the original image
          dimensions, adding the region `(x, y)` offset when reading a `region`.
        - Only OSS image URLs without query parameters are supported.

        Args:
            url: Image URL taken verbatim from the conversation or tool results in this
                session; do not construct URLs yourself.
            region: View just this rectangle of the image (`x`, `y`, `width`, `height`
                in original-image pixel coordinates); parts extending past the right or
                bottom edge are clipped to the boundary.
            full_resolution: Skip default downscaling and view at native resolution.
        """

        if region is not None and full_resolution:
            raise ModelRetry(
                "region 与 full_resolution 二选一：看局部小字给 region，看整幅原分辨率给 "
                "full_resolution。去掉一个再调。"
            )
        try:
            info = await self._capability.probe.image_info(url)
        except MediaProbeFailed as exc:
            _logger.warning("读图失败", url=url, reason=str(exc))
            raise ModelRetry(f"图片无法读取（{exc}）。") from exc
        try:
            delivered, clause, advice = self._deliver(
                url, info, region=region, full_resolution=full_resolution
            )
        except ValueError as exc:
            _logger.warning("读图失败", url=url, reason=str(exc))
            raise ModelRetry(f"图片无法读取（{exc}）。") from exc
        summary = (
            f"原图 {info.width}×{info.height} 像素，{info.media_type}，"
            f"{_bytes_label(info.size_bytes)}；{clause}。{advice}"
        )
        return ToolReturn(
            return_value=[
                media_tag_open("image", url),
                summary,
                ImageUrl(url=delivered, media_type=info.media_type),
                media_tag_close("image"),
            ],
            metadata=media_grid([(delivered, None)]),
        )

    def _deliver(
        self, url: str, info: ImageInfo, *, region: CropRegion | None, full_resolution: bool
    ) -> tuple[str, str, str]:
        if region is not None:
            if region.x >= info.width or region.y >= info.height:
                raise ModelRetry(
                    f"region 的起点 ({region.x}, {region.y}) 落在原图之外：原图是 "
                    f"{info.width}×{info.height} 像素，按这个尺寸重算坐标再调。"
                )
            seen_width = min(region.width, info.width - region.x)
            seen_height = min(region.height, info.height - region.y)
            shrunk = max(seen_width, seen_height) > IMAGE_CONTEXT_MAX_EDGE
            delivered = cropped_image_url(
                url,
                x=region.x,
                y=region.y,
                width=region.width,
                height=region.height,
                max_edge=IMAGE_CONTEXT_MAX_EDGE if shrunk else None,
            )
            clause = f"当前显示区域 x={region.x}, y={region.y}, {seen_width}×{seen_height}"
            if shrunk:
                clause += f"，已降采样到长边 {IMAGE_CONTEXT_MAX_EDGE}"
            return delivered, clause, "输出原图坐标时加上区域偏移 (x, y)。"
        if full_resolution:
            if info.size_bytes > FULL_RESOLUTION_MAX_BYTES:
                raise ModelRetry(
                    f"这张图 {_bytes_label(info.size_bytes)}，超过按原分辨率读取的上限 "
                    f"{_bytes_label(FULL_RESOLUTION_MAX_BYTES)}；改用 region 按原图像素"
                    "坐标分块看。"
                )
            return url, "原分辨率", ""
        if max(info.width, info.height) > IMAGE_CONTEXT_MAX_EDGE:
            return (
                resized_image_url(url, max_edge=IMAGE_CONTEXT_MAX_EDGE),
                f"已降采样到长边 {IMAGE_CONTEXT_MAX_EDGE}",
                "要看清小字或细节，用 `region` 按原图像素坐标看一块。输出坐标一律按原图尺寸算。",
            )
        return url, "未缩放", ""

    async def _write(
        self, scope: str, key: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        return await write_or_retry(
            self._capability.space.store, scope, key, content, expected_version=expected_version
        )

    async def _entries(self, scope: str, prefix: str) -> Sequence[FileEntry]:
        try:
            return await self._capability.space.store.entries(scope, prefix=prefix)
        except InvalidPath as exc:
            raise ModelRetry(str(exc)) from exc


__all__ = [
    "CAPABILITY_ID",
    "FULL_RESOLUTION_MAX_BYTES",
    "MAX_READ_CHARS",
    "MAX_READ_LINES",
    "MAX_SEARCH_RESULTS",
    "CropRegion",
    "Workspace",
    "WorkspaceToolset",
]
