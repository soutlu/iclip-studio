from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path
from typing import Final

from iclip.platform.media.errors import MediaError

_STDERR_LIMIT: Final = 400

PROBE_TIMEOUT_SECONDS: Final = 30.0
ENCODE_TIMEOUT_SECONDS: Final = 900.0

# 滤镜图对冒号、引号、反斜杠、逗号等要转义两层；只收不用转义的字符。
_SAFE_FILTER_PATH: Final = re.compile(r"[A-Za-z0-9/._+-]+")


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


async def run(args: list[str], *, timeout: float) -> bytes:
    stdout, _ = await communicate(args, timeout=timeout)
    return stdout


async def communicate(args: list[str], *, timeout: float) -> tuple[bytes, bytes]:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            # 子进程读终端会让后台进程组收到 SIGTTIN，连同后端一起暂停。
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise MediaError(f"PATH 上找不到 {args[0]}") from None
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise MediaError(f"{args[0]} 超过 {timeout:.0f} 秒还没结束") from None
    except asyncio.CancelledError:
        # 取消 asyncio 任务不会结束它起的子进程。
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        detail = stderr.decode(errors="replace")[:_STDERR_LIMIT]
        raise MediaError(f"{args[0]} 失败（退出码 {process.returncode}）: {detail}")
    return stdout, stderr


def check_output(dest: Path, *, max_bytes: int) -> None:
    size = dest.stat().st_size if dest.is_file() else 0
    if size == 0:
        raise MediaError(f"ffmpeg 没产出内容: {dest.name}")
    if size > max_bytes:
        raise MediaError(f"产物 {size} 字节，超过 {max_bytes} 字节的上限: {dest.name}")


def filter_path(path: Path) -> str:
    text = str(path)
    if not _SAFE_FILTER_PATH.fullmatch(text):
        raise MediaError(f"路径里有滤镜参数要转义的字符: {text}")
    return text


async def require_subtitles_filter() -> None:
    listing = await run(["ffmpeg", "-hide_banner", "-filters"], timeout=PROBE_TIMEOUT_SECONDS)
    if not any(line.split()[1:2] == ["subtitles"] for line in listing.decode().splitlines()):
        raise MediaError("本机的 ffmpeg 没有 subtitles 滤镜（libass），烧不了字幕")


__all__ = [
    "ENCODE_TIMEOUT_SECONDS",
    "PROBE_TIMEOUT_SECONDS",
    "check_output",
    "communicate",
    "ffmpeg_available",
    "filter_path",
    "require_subtitles_filter",
    "run",
]
