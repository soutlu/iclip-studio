from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from tempfile import TemporaryDirectory

from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.process import PROBE_TIMEOUT_SECONDS, run
from iclip.platform.shot_media.grid import GrayImage, parse_pgm

EXTRACT_TIMEOUT_SECONDS = 900.0

CROP_TIMEOUT_SECONDS = 120.0

DETECT_WIDTH = 640


async def extract_frames(path: Path, *, fps: float, out_dir: Path, codec: MediaCodec) -> list[Path]:
    if fps <= 0:
        raise MediaError(f"抽帧帧率必须为正: {fps}")
    await run(
        [
            "ffmpeg",
            "-v",
            "error",
            *codec.decode,
            "-i",
            str(path),
            "-vf",
            f"fps={fps}",
            "-q:v",
            "2",
            "-f",
            "image2",
            str(out_dir / "f%06d.jpg"),
        ],
        timeout=EXTRACT_TIMEOUT_SECONDS,
    )
    frames = sorted(out_dir.glob("f*.jpg"))
    if not frames:
        raise MediaError(f"整片抽帧没产出任何帧: {path.name}")
    return frames


async def decode_gray(path: Path, *, max_width: int = DETECT_WIDTH) -> tuple[GrayImage, int]:
    stdout = await run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            f"scale='min({max_width},iw)':-2,format=gray",
            "-f",
            "image2",
            "-c:v",
            "pgm",
            "pipe:1",
        ],
        timeout=CROP_TIMEOUT_SECONDS,
    )
    return parse_pgm(stdout), await _image_width(path)


async def _image_width(path: Path) -> int:
    stdout = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    text = stdout.decode(errors="replace").strip()
    try:
        width = int(text)
    except ValueError as exc:
        raise MediaError(f"ffprobe 报的图宽看不懂: {text!r}") from exc
    if width <= 0:
        raise MediaError(f"ffprobe 报的图宽不是正数: {width}")
    return width


async def crop_cells(path: Path, boxes: Sequence[tuple[int, int, int, int]]) -> list[bytes]:
    if not boxes:
        raise MediaError("没有要裁的区域")
    with TemporaryDirectory(prefix="shot-video-cells-") as tmp:
        out_dir = Path(tmp)
        chains = ";".join(
            f"[0:v]crop={w}:{h}:{x}:{y}[c{index}]" for index, (x, y, w, h) in enumerate(boxes)
        )
        args = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-filter_complex", chains]
        for index in range(len(boxes)):
            args += [
                "-map",
                f"[c{index}]",
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(out_dir / f"c{index}.jpg"),
            ]
        await run(args, timeout=CROP_TIMEOUT_SECONDS)
        cells: list[bytes] = []
        for index in range(len(boxes)):
            cell = out_dir / f"c{index}.jpg"
            if not cell.is_file() or cell.stat().st_size == 0:
                raise MediaError(f"第 {index + 1} 格裁出来是空的")
            cells.append(cell.read_bytes())
    return cells


__all__ = [
    "DETECT_WIDTH",
    "EXTRACT_TIMEOUT_SECONDS",
    "crop_cells",
    "decode_gray",
    "extract_frames",
]
