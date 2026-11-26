from __future__ import annotations

from pathlib import Path

from iclip.platform.media.fetch import MAX_IMAGE_BYTES
from iclip.platform.media.process import ENCODE_TIMEOUT_SECONDS, check_output, run


async def last_frame_before(source: Path, end: float, dest: Path) -> None:
    """把 ``source`` 里时间早于 ``end`` 秒的最后一帧存成 JPEG 到 ``dest``。

    ``end`` 越过结尾时取最后一帧；``end`` 不晚于第一帧时取第一帧。抽不出帧抛 ``MediaError``。
    """

    await _keep_last_selected(source, f"lt(t\\,{end:.3f})+isnan(prev_t)", dest)


async def first_frame_from(source: Path, start: float, dest: Path) -> None:
    """把 ``source`` 里时间不早于 ``start`` 秒的第一帧存成 JPEG 到 ``dest``。

    ``start`` 越过结尾时取最后一帧。抽不出帧抛 ``MediaError``。
    """

    at = f"{start:.3f}"
    await _keep_last_selected(
        source, f"lt(t\\,{at})+gte(t\\,{at})*(isnan(prev_t)+lt(prev_t\\,{at}))", dest
    )


async def _keep_last_selected(source: Path, selected: str, dest: Path) -> None:
    # 选中的帧依次覆盖写进同一个文件，留下的是最后选中的那一帧；时间判定与合成切段的 trim 一致。
    await run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source),
            "-vf", f"select='{selected}'", "-update", "1", "-q:v", "2", str(dest),
        ],
        timeout=ENCODE_TIMEOUT_SECONDS,
    )  # fmt: skip
    check_output(dest, max_bytes=MAX_IMAGE_BYTES)


__all__ = ["first_frame_from", "last_frame_before"]
