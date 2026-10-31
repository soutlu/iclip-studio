"""使用合成灰度图验证网格检测、等分回退、画幅收缩和坐标还原。"""

from __future__ import annotations

from collections.abc import Collection

import pytest

from iclip.platform.shot_media.grid import (
    GrayImage,
    GridError,
    fit_box_to_aspect,
    grid_cell_boxes,
)

GUTTER = 255
CELL = 128


def make_image(
    width: int,
    height: int,
    *,
    white_cols: Collection[int] = (),
    white_rows: Collection[int] = (),
) -> GrayImage:
    """构造灰度图：指定整行、整列为白色分隔带，其余像素为中灰。"""

    cols, rows = set(white_cols), set(white_rows)
    pixels = bytearray(CELL for _ in range(width * height))
    for y in range(height):
        for x in range(width):
            if x in cols or y in rows:
                pixels[y * width + x] = GUTTER
    return GrayImage(width=width, height=height, pixels=bytes(pixels))


def test_detects_offset_gutter_and_trims_outer_border() -> None:

    image = make_image(
        100,
        100,
        white_cols={*range(0, 6), *range(44, 48), *range(95, 100)},
        white_rows={*range(48, 52)},
    )
    layout = grid_cell_boxes(image, rows=2, cols=2)
    assert layout.detected
    xs = {(x, w) for x, _, w, _ in layout.boxes}
    assert xs == {(6, 38), (48, 47)}


def test_falls_back_to_equal_split_and_says_so() -> None:

    layout = grid_cell_boxes(make_image(100, 100), rows=2, cols=2)
    assert layout.boxes == ((0, 0, 50, 50), (50, 0, 50, 50), (0, 50, 50, 50), (50, 50, 50, 50))
    assert not layout.detected


def test_one_axis_detected_is_not_detected() -> None:
    """任一轴检测失败都应标记等分回退，避免宣称所有坐标均来自检测。"""

    image = make_image(100, 100, white_cols={*range(44, 48)})
    layout = grid_cell_boxes(image, rows=2, cols=2)
    assert (layout.detected_x, layout.detected_y) == (True, False)
    assert not layout.detected


def test_gutter_outside_search_band_is_ignored() -> None:
    """离等分线太远的白带不是网格线（可能是画面本身的白色区域）。"""

    # 切出的两段都不短于最短区间，只有搜索带能拒掉它。
    image = make_image(100, 100, white_cols={*range(28, 32)})
    layout = grid_cell_boxes(image, rows=1, cols=2)
    assert not layout.detected_x
    assert layout.boxes == ((0, 0, 50, 100), (50, 0, 50, 100))


def test_black_gutter_counts_too() -> None:
    pixels = bytearray(CELL for _ in range(100 * 10))
    for y in range(10):
        for x in range(46, 50):
            pixels[y * 100 + x] = 0
    layout = grid_cell_boxes(GrayImage(width=100, height=10, pixels=bytes(pixels)), rows=1, cols=2)
    assert layout.detected_x


@pytest.mark.parametrize(("rows", "cols"), [(0, 2), (2, 0), (7, 2), (2, 7), (-1, 2)])
def test_grid_side_bounds(rows: int, cols: int) -> None:
    with pytest.raises(GridError):
        grid_cell_boxes(make_image(40, 40), rows=rows, cols=cols)


def test_aspect_within_tolerance_is_left_alone() -> None:
    box = (0, 0, 101, 100)
    assert fit_box_to_aspect(box, 1.0) == box


def test_aspect_shrinks_centered() -> None:
    assert fit_box_to_aspect((10, 20, 200, 100), 1.0) == (60, 20, 100, 100)
    assert fit_box_to_aspect((10, 20, 100, 200), 1.0) == (10, 70, 100, 100)


def test_aspect_shrink_handles_large_drift() -> None:

    assert fit_box_to_aspect((0, 0, 400, 100), 9 / 16) == (172, 0, 56, 100)


@pytest.mark.parametrize("box", [(0, 0, 0, 10), (0, 0, 10, 0), (0, 0, -1, 10)])
def test_aspect_rejects_empty_box(box: tuple[int, int, int, int]) -> None:
    with pytest.raises(GridError, match="尺寸非法"):
        fit_box_to_aspect(box, 1.0)
