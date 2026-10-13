"""图片文件头：格式按内容认，手机拍的多帧 JPEG（MPO）算 image/jpeg。"""

from __future__ import annotations

import pytest

from iclip.platform.media.image import read_image_header
from tests.helpers.media import multi_picture_jpeg

pytestmark = pytest.mark.unit


def test_a_multi_picture_jpeg_reads_as_jpeg() -> None:
    header = read_image_header(multi_picture_jpeg())

    assert header is not None
    assert (header.mime, header.width, header.height) == ("image/jpeg", 1200, 1600)


def test_bytes_that_are_not_an_image_read_as_nothing() -> None:
    assert read_image_header(b"<html>not found</html>") is None
