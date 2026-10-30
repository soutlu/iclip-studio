"""``shot_video`` 插件的两个媒体端口：取帧拼板（``FrameBoards``）与宫格切格（``GridCuts``）。

下载、探时长、算取帧 key、判断能否复用台账、上传与记切图都在这里，像素活交给
[platform/shot_media/](../platform/shot_media/__init__.py)；失败换成插件端口声明的错误。"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Final, Protocol

import httpx
import structlog
from iclip_video.shot_document import AspectError, parse_aspect
from iclip_video.shot_video.ports import (
    EXTRACTION_VERSION,
    AnchorSheets,
    BoardsNotStored,
    BoardsResult,
    BoardsUnreadable,
    ExtractionLedger,
    GridCutFailed,
    LedgerBoard,
    ShotCells,
    ShotsOutOfRange,
)
from iclip_video.shot_video.prompt import GRID_CELLS, GRID_COLS, GRID_ROWS
from iclip_video.shot_video.shots import (
    FRAME_INTERVAL_MS,
    ShotSpan,
    extraction_key,
    sample_rows,
)

from iclip.domains.generation.service import SettledRecords
from iclip.domains.identity.public import Principal
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, fetched
from iclip.platform.media.probe import probe_duration_ms
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable
from iclip.platform.shot_media.board import BoardError
from iclip.platform.shot_media.grid import GridError
from iclip.platform.shot_media.pipeline import cut_grid, render_boards

_JPEG: Final = "image/jpeg"

_logger = structlog.stdlib.get_logger(__name__)


class PublicObjects(Protocol):
    """写可公开访问的对象，并按 key 算出同一个公网地址。"""

    async def put_public_object(self, *, object_key: str, content: bytes, content_type: str) -> str:
        """写入并返回 ``public_url(object_key)``；同 key 已存在即复用。存不下来抛
        ``ObjectStoreUnavailable``。"""
        ...

    def public_url(self, object_key: str) -> str:
        """对象 key 对应的公网地址，与写入时返回的逐字相同；不访问存储。"""
        ...


class FrameBoardsAdapter:
    """``FrameBoards`` 的实现。每次调用只下载一次参考视频；``fetch_url`` 在下载前换算地址（本桶对象走
    内网），抽帧解码用 ``codec``。"""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        fetch_url: Callable[[str], str],
        objects: PublicObjects,
        codec: MediaCodec,
    ) -> None:
        self._client = client
        self._fetch_url = fetch_url
        self._objects = objects
        self._codec = codec

    async def boards(
        self,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
        previous: ExtractionLedger | None,
    ) -> BoardsResult:
        try:
            async with fetched(
                self._client, self._fetch_url(video_url), max_bytes=MAX_VIDEO_BYTES, suffix=".mp4"
            ) as source:
                _check_in_range(rows, duration_ms=await probe_duration_ms(source))
                video_hash = await asyncio.to_thread(_sha256_file, source)
                key = extraction_key(
                    video_hash=video_hash, rows=rows, interval_ms=FRAME_INTERVAL_MS
                )
                if previous is not None and reusable(
                    previous, key=key, public_url=self._objects.public_url
                ):
                    return BoardsResult(ledger=previous, reused=True)
                ledger = await self._build(source, key=key, rows=rows)
        except (MediaError, BoardError) as exc:
            raise BoardsUnreadable(str(exc)) from exc
        except ObjectStoreUnavailable as exc:
            raise BoardsNotStored(
                f"图片没存进对象存储：{exc}。重新调用一次；已经存下的会直接复用，不重传。"
            ) from exc
        return BoardsResult(ledger=ledger, reused=False)

    async def _build(
        self, source: Path, *, key: str, rows: Sequence[Sequence[ShotSpan]]
    ) -> ExtractionLedger:
        """按固定间隔抽帧，按结构分组生成公开预览板与取帧台账。

        台账只存复用判定用的版本与 key，以及实际建成的板号与地址（复用时按 key 重算核对）。
        板上有哪几个镜头由插件按 ``rows`` 现算——rows 是 key 的组成部分，命中复用时
        它与建账时逐字相同。"""

        sampled = sample_rows(rows, interval_ms=FRAME_INTERVAL_MS)
        rendered = await render_boards(
            source,
            [[(cell.cell_id, cell.src_ms) for cell in cells] for cells in sampled],
            interval_ms=FRAME_INTERVAL_MS,
            codec=self._codec,
        )
        boards: list[LedgerBoard] = []
        for index, image in rendered:
            url = await self._objects.put_public_object(
                object_key=MEDIA_PATHS.shot_board(extraction_key=key, index=index),
                content=image,
                content_type=_JPEG,
            )
            boards.append(LedgerBoard(board=index, url=url))
        return ExtractionLedger(
            extraction_version=EXTRACTION_VERSION, extraction_key=key, boards=boards
        )


def reusable(ledger: ExtractionLedger, *, key: str, public_url: Callable[[str], str]) -> bool:
    """工作区里的台账是不是这次取帧的产物：版本是当前版本、key 相同，且每块板的地址都是本系统按
    该 key 与板号发布的地址。

    台账在模型可写的工作区里；板地址按 key 与板号重算后整串比对，复用时登记的只会是本系统发布的
    地址。"""

    if ledger.extraction_version != EXTRACTION_VERSION or ledger.extraction_key != key:
        return False
    forged = [
        board.board
        for board in ledger.boards
        if board.url != public_url(MEDIA_PATHS.shot_board(extraction_key=key, index=board.board))
    ]
    if forged:
        _logger.warning("取帧台账板地址与产物不符，按不存在处理", boards=forged)
        return False
    return True


def _check_in_range(rows: Sequence[Sequence[ShotSpan]], *, duration_ms: int) -> None:
    # 允许末镜头时间码因取整超出媒体时长 500 ms。
    out_of_range = [shot for row in rows for shot in row if shot.end_ms > duration_ms + 500]
    if out_of_range:
        ids = ", ".join(str(shot.shot_id) for shot in out_of_range)
        raise ShotsOutOfRange(
            f"镜头时间戳越界（视频时长 {duration_ms}ms）：镜头 {ids}。对着拆解文档核一遍，"
            "用 edit_file 就地改正后重新调用。"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class CutRecords(Protocol):
    """把从一张宫格切出来、已转存的几格各记一条切图记录。"""

    async def record_cuts(
        self, user_id: uuid.UUID, grid_job_id: uuid.UUID, urls: Sequence[str]
    ) -> None:
        """来源是 ``grid_job_id`` 那张宫格，与 ``urls`` 同序；``user_id`` 是运行属主。"""
        ...


class CutRecordsAdapter:
    """``CutRecords`` 接到生成域的切图记录上。每次调用都用 ``resolve_principal`` 按运行属主 id 重建
    主体，它的错误原样抛出。"""

    def __init__(
        self,
        records: SettledRecords,
        resolve_principal: Callable[[uuid.UUID], Awaitable[Principal]],
    ) -> None:
        self._records = records
        self._resolve_principal = resolve_principal

    async def record_cuts(
        self, user_id: uuid.UUID, grid_job_id: uuid.UUID, urls: Sequence[str]
    ) -> None:
        principal = await self._resolve_principal(user_id)
        await self._records.record_cuts(principal, grid_job_id, urls)


def cut_object_keys(job_id: uuid.UUID, cells: ShotCells | AnchorSheets) -> list[str]:
    """切下来的每一格存到哪个对象 key，与 ``cells`` 同序：出图一格按帧号，设定图一格按序号。"""

    if isinstance(cells, ShotCells):
        return [MEDIA_PATHS.shot_cell(job_id=job_id, cell_id=cell) for cell in cells.cell_ids]
    return [MEDIA_PATHS.anchor_sheet(job_id=job_id, index=index) for index in cells.indexes]


class GridCutsAdapter:
    """``GridCuts`` 的实现：下载整图、按 ``GRID_ROWS`` × ``GRID_COLS`` 切格、按 ``cut_object_keys`` 定
    每格的 key 并行转存后记切图。``fetch_url`` 在下载整图前换算地址（本桶对象走内网）。"""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        fetch_url: Callable[[str], str],
        objects: PublicObjects,
        records: CutRecords,
    ) -> None:
        self._client = client
        self._fetch_url = fetch_url
        self._objects = objects
        self._records = records

    async def cut(
        self,
        user_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        grid_url: str,
        cells: ShotCells | AnchorSheets,
        aspect: str | None,
    ) -> tuple[str, ...]:
        object_keys = cut_object_keys(job_id, cells)
        try:
            pieces = await self._slice(grid_url, aspect=aspect, job_id=job_id)
        except (MediaError, GridError, AspectError) as exc:
            raise GridCutFailed(str(exc)) from exc
        if len(pieces) != GRID_CELLS:
            raise GridCutFailed("整图切格数量异常")
        try:
            urls = await self._put_all(
                list(zip(object_keys, pieces[: len(object_keys)], strict=True))
            )
        except ObjectStoreUnavailable as exc:
            raise GridCutFailed(str(exc)) from exc
        await self._records.record_cuts(user_id, job_id, urls)
        return tuple(urls)

    async def _slice(
        self, grid_url: str, *, aspect: str | None, job_id: uuid.UUID
    ) -> tuple[bytes, ...]:
        """检测网格并裁剪，指定 aspect 时居中收缩；检测不到分隔带的轴按等分退回，并记告警。"""

        async with fetched(
            self._client, self._fetch_url(grid_url), max_bytes=MAX_IMAGE_BYTES, suffix=".img"
        ) as source:
            ratio = parse_aspect(aspect) if aspect is not None else None
            cut = await cut_grid(source, rows=GRID_ROWS, cols=GRID_COLS, aspect_ratio=ratio)
        if not cut.layout.detected:
            _logger.warning(
                "网格分隔带检测不全，按等分裁切",
                job_id=str(job_id),
                cells=len(cut.layout.boxes),
                detected_x=cut.layout.detected_x,
                detected_y=cut.layout.detected_y,
            )
        return cut.cells

    async def _put_all(self, cells: Sequence[tuple[str, bytes]]) -> list[str]:
        """并行上传格子并保持返回顺序；等待全部任务结束后报告首个失败，避免遗留未收集异常。"""

        results = await asyncio.gather(
            *(
                self._objects.put_public_object(
                    object_key=object_key, content=content, content_type=_JPEG
                )
                for object_key, content in cells
            ),
            return_exceptions=True,
        )
        urls: list[str] = []
        for result in results:
            if isinstance(result, BaseException):
                raise result
            urls.append(result)
        return urls


__all__ = [
    "CutRecords",
    "CutRecordsAdapter",
    "FrameBoardsAdapter",
    "GridCutsAdapter",
    "PublicObjects",
    "cut_object_keys",
    "reusable",
]
