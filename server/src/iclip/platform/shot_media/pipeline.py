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
    cells: tuple[bytes, ...]
    layout: GridLayout


async def cut_grid(source: Path, *, rows: int, cols: int, aspect_ratio: float | None) -> GridCut:
    gray, full_width = await decode_gray(source)
    layout = grid_cell_boxes(gray, rows=rows, cols=cols)
    boxes = [scale_box(box, from_width=gray.width, to_width=full_width) for box in layout.boxes]
    if aspect_ratio is not None:
        boxes = [fit_box_to_aspect(box, aspect_ratio) for box in boxes]
    return GridCut(cells=tuple(await crop_cells(source, boxes)), layout=layout)


__all__ = ["GridCut", "cut_grid", "render_boards"]
