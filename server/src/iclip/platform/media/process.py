from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Final

from iclip.platform.media.errors import MediaError

_STDERR_LIMIT: Final = 400

PROBE_TIMEOUT_SECONDS: Final = 30.0
ENCODE_TIMEOUT_SECONDS: Final = 900.0


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


async def run(args: list[str], *, timeout: float) -> bytes:
    stdout, _ = await communicate(args, timeout=timeout)
    return stdout


async def communicate(args: list[str], *, timeout: float) -> tuple[bytes, bytes]:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            # 子进程读取终端输入会触发 SIGTTIN 挂起后台进程组，须将 stdin 重定向至 DEVNULL。
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise MediaError(f"系统 PATH 中未找到可执行文件：{args[0]}") from None
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise MediaError(f"{args[0]} 执行超时（超过 {timeout:.0f} 秒）") from None
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        detail = stderr.decode(errors="replace")[:_STDERR_LIMIT]
        raise MediaError(f"{args[0]} 执行失败（退出码 {process.returncode}）：{detail}")
    return stdout, stderr


def check_output(dest: Path, *, max_bytes: int) -> None:
    size = dest.stat().st_size if dest.is_file() else 0
    if size == 0:
        raise MediaError(f"ffmpeg 未生成有效内容：{dest.name}")
    if size > max_bytes:
        raise MediaError(f"输出文件大小为 {size} 字节，超出上限（{max_bytes} 字节）：{dest.name}")


__all__ = [
    "ENCODE_TIMEOUT_SECONDS",
    "PROBE_TIMEOUT_SECONDS",
    "check_output",
    "communicate",
    "ffmpeg_available",
    "run",
]
