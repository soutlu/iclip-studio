from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

_WHITESPACE = frozenset(b" \t\r\n\v\f")
_COMMENT = ord("#")

MAX_GRID_SIDE = 6


class GridError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class GrayImage:
    width: int
    height: int
    pixels: bytes


@dataclass(frozen=True, slots=True)
class GridLayout:
    boxes: tuple[tuple[int, int, int, int], ...]
    detected_x: bool
    detected_y: bool

    @property
    def detected(self) -> bool:
        return self.detected_x and self.detected_y


_WHITE_LEVEL = 230
_BLACK_LEVEL = 25
_GUTTER_SHARE = 0.95
_SEARCH_SHARE = 0.12
_MARGIN_CAP_SHARE = 0.08
_MIN_GUTTER_PX = 2
_ASPECT_TOLERANCE = 0.02


def parse_pgm(data: bytes) -> GrayImage:
    magic, pos = _header_token(data, 0)
    if magic != b"P5":
        raise GridError(f"PGM 魔数必须是 P5，实际是 {magic!r}")
    width, pos = _header_int(data, pos, field="width")
    height, pos = _header_int(data, pos, field="height")
    maxval, pos = _header_int(data, pos, field="maxval")
    if width <= 0 or height <= 0:
        raise GridError(f"PGM 尺寸非法: {width}x{height}")
    if maxval != 255:
        raise GridError(f"PGM maxval 必须是 255，实际是 {maxval}")
    if pos >= len(data) or data[pos] not in _WHITESPACE:
        raise GridError("PGM maxval 后面缺一个空白分隔符")
    pos += 1
    end = pos + width * height
    if end > len(data):
        raise GridError("PGM 像素数据不够")
    return GrayImage(width=width, height=height, pixels=data[pos:end])


def grid_cell_boxes(image: GrayImage, *, rows: int, cols: int) -> GridLayout:
    _check_side(rows, "rows")
    _check_side(cols, "cols")
    width, height = image.width, image.height
    if len(image.pixels) != width * height:
        raise GridError("灰度图的像素长度和尺寸对不上")
    table = bytes(
        1 if value >= _WHITE_LEVEL else 2 if value <= _BLACK_LEVEL else 0 for value in range(256)
    )
    mask = image.pixels.translate(table)
    col_flags = [_is_gutter(mask[x::width], height) for x in range(width)]
    row_flags = [_is_gutter(mask[y * width : (y + 1) * width], width) for y in range(height)]
    x_segments, detected_x = _axis_segments(col_flags, count=cols)
    y_segments, detected_y = _axis_segments(row_flags, count=rows)
    return GridLayout(
        boxes=tuple((x0, y0, x1 - x0, y1 - y0) for y0, y1 in y_segments for x0, x1 in x_segments),
        detected_x=detected_x,
        detected_y=detected_y,
    )


def fit_box_to_aspect(box: tuple[int, int, int, int], ratio: float) -> tuple[int, int, int, int]:
    x, y, w, h = box
    if w <= 0 or h <= 0:
        raise GridError(f"格区域尺寸非法: {box}")
    current = w / h
    if abs(current - ratio) / ratio <= _ASPECT_TOLERANCE:
        return box
    if current > ratio:
        new_w = max(1, round(h * ratio))
        return (x + (w - new_w) // 2, y, new_w, h)
    new_h = max(1, round(w / ratio))
    return (x, y + (h - new_h) // 2, w, new_h)


def scale_box(
    box: tuple[int, int, int, int], *, from_width: int, to_width: int
) -> tuple[int, int, int, int]:
    if from_width <= 0 or to_width <= 0:
        raise GridError("缩放的宽度必须是正数")
    factor = to_width / from_width
    x, y, w, h = box
    return (
        round(x * factor),
        round(y * factor),
        max(1, round(w * factor)),
        max(1, round(h * factor)),
    )


def _check_side(value: int, name: str) -> None:
    if not 1 <= value <= MAX_GRID_SIDE:
        raise GridError(f"{name} 必须在 1 到 {MAX_GRID_SIDE} 之间；收到的是 {value}")


def _is_gutter(line: bytes, size: int) -> bool:
    need = size * _GUTTER_SHARE
    return line.count(1) >= need or line.count(2) >= need


def _axis_segments(flags: Sequence[bool], *, count: int) -> tuple[list[tuple[int, int]], bool]:
    length = len(flags)
    naive = [(k * length // count, (k + 1) * length // count) for k in range(count)]
    if count == 1 or length < count * 4:
        return naive, False

    runs = _gutter_runs(flags)
    band = int(length * _SEARCH_SHARE)
    cuts: list[tuple[int, int]] = []
    hits = 0
    for k in range(1, count):
        boundary = k * length // count
        candidates = [
            run
            for run in runs
            if run[1] - run[0] >= _MIN_GUTTER_PX
            and run[0] <= boundary + band
            and run[1] >= boundary - band
        ]
        if not candidates:
            cuts.append((boundary, boundary))
            continue
        hits += 1
        cuts.append(min(candidates, key=lambda run: abs((run[0] + run[1]) // 2 - boundary)))

    margin_cap = int(length * _MARGIN_CAP_SHARE)
    lead = 0
    while lead < margin_cap and flags[lead]:
        lead += 1
    trail = length
    while trail > length - margin_cap and flags[trail - 1]:
        trail -= 1

    starts = [lead, *(end for _, end in cuts)]
    ends = [*(start for start, _ in cuts), trail]
    segments = list(zip(starts, ends, strict=True))
    min_len = length // (count * 2)
    if any(end - start < min_len for start, end in segments):
        return naive, False
    return segments, hits == count - 1


def _gutter_runs(flags: Sequence[bool]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _header_token(data: bytes, pos: int) -> tuple[bytes, int]:
    length = len(data)
    while pos < length:
        byte = data[pos]
        if byte in _WHITESPACE:
            pos += 1
        elif byte == _COMMENT:
            while pos < length and data[pos] not in (10, 13):
                pos += 1
        else:
            break
    if pos >= length:
        raise GridError("PGM 头部提前结束")
    start = pos
    while pos < length and data[pos] not in _WHITESPACE:
        pos += 1
    return data[start:pos], pos


def _header_int(data: bytes, pos: int, *, field: str) -> tuple[int, int]:
    token, next_pos = _header_token(data, pos)
    try:
        return int(token), next_pos
    except ValueError as exc:
        raise GridError(f"PGM 头部的 {field} 不是整数: {token!r}") from exc


__all__ = [
    "MAX_GRID_SIDE",
    "GrayImage",
    "GridError",
    "GridLayout",
    "fit_box_to_aspect",
    "grid_cell_boxes",
    "parse_pgm",
    "scale_box",
]
