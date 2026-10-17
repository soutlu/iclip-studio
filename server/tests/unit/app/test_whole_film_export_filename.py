"""导出整片的下载文件名按北京时间写签发那一刻。"""

from __future__ import annotations

from datetime import UTC, datetime

from iclip.app.whole_film_exports import export_filename


def test_the_download_name_is_stamped_in_beijing_time() -> None:
    assert export_filename(datetime(2026, 10, 17, 16, 5, tzinfo=UTC)) == "整片-20261018-0005.mp4"
