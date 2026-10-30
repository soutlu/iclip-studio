"""一次取帧拼板、一次宫格切格的媒体流水线，输入都是已下载到本地的文件。"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from iclip.platform.media.codec import MediaCodec
from iclip.platform.shot_media.board import board_geometry, compose_board, image_aspect
from iclip.platform.shot_media.ffmpeg import crop_cells, decode_gray, extract_frames
from iclip.platform.shot_media.grid import (
    GridLayout,
    fit_box_to_aspect,
    grid_cell_boxes,
    scale_box,
)


async def render_boards(
    source: Path,
    rows: Sequence[Sequence[tuple[str, int]]],
    *,
    interval_ms: int,
    codec: MediaCodec,
) -> list[tuple[int, bytes]]:
    """按 ``interval_ms`` 整片抽帧，每行拼一块带标签的预览板，解码用 ``codec`` 的选项。

    每格是 ``(标签, 源时刻毫秒)``，取第 ``源时刻 // interval_ms`` 帧；落在片尾之外的格子不上板。
    交回 ``(行号, JPEG)``，行号从 1 起；一格都不在片内的行不出板，所以行号可能不连续。

    Raises:
        MediaError: 抽帧失败。
        BoardError: 帧解不开或排不下。
    """

    with TemporaryDirectory(prefix="shot-video-frames-") as tmp:
        frames = await extract_frames(
            source, fps=1000 / interval_ms, out_dir=Path(tmp), codec=codec
        )
        cell_aspect = await asyncio.to_thread(image_aspect, frames[0])
        boards: list[tuple[int, bytes]] = []
        for index, cells in enumerate(rows, start=1):
            in_range = [
                (label, frames[ms // interval_ms])
                for label, ms in cells
                if ms // interval_ms < len(frames)
            ]
            if not in_range:
                continue
            geometry = await asyncio.to_thread(
                board_geometry, len(in_range), cell_aspect=cell_aspect
            )
            image = await asyncio.to_thread(compose_board, in_range, geometry=geometry)
            boards.append((index, image))
    return boards


@dataclass(frozen=True, slots=True)
class GridCut:
    """一次切格：按阅读顺序的各格 JPEG，以及分隔带检测的结果（是否退回了等分）。"""

    cells: tuple[bytes, ...]
    layout: GridLayout


async def cut_grid(source: Path, *, rows: int, cols: int, aspect_ratio: float | None) -> GridCut:
    """在降采样灰度图上检测 ``rows`` × ``cols`` 的分隔带，坐标还原到原图后裁切；给了
    ``aspect_ratio`` 就把每格居中收缩到这个宽高比。检测不到分隔带的轴按等分切。

    Raises:
        MediaError: 解码或裁切失败。
        GridError: 图或网格参数不合法。
    """

    gray, full_width = await decode_gray(source)
    layout = grid_cell_boxes(gray, rows=rows, cols=cols)
    boxes = [scale_box(box, from_width=gray.width, to_width=full_width) for box in layout.boxes]
    if aspect_ratio is not None:
        boxes = [fit_box_to_aspect(box, aspect_ratio) for box in boxes]
    return GridCut(cells=tuple(await crop_cells(source, boxes)), layout=layout)


__all__ = ["GridCut", "cut_grid", "render_boards"]
