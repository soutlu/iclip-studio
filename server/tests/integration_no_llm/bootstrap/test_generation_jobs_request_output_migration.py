"""生成记录表把各种记录自己的产出并进 ``output``、输入并进 ``request`` 的迁移：在 0038 按旧结构给
每种记录造一行，升级后逐行核对 output、request 与 provider，降级后整表与索引原样还原；搬不过去的
行让整个迁移回滚。升降级在一次性库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.migrations import alembic_config

BEFORE = "ad8ae2f51ce1"
"""0038，产出与区间、外部底图还各占一列。"""

AFTER = "e7b3c91d4a26"
"""0039，产出并进 output，区间与外部底图并进 request。"""

_INSERT = text(
    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind, operation,"
    " provider, request, status, source_job_id, root_job_id, shot_index, source_url,"
    " range_start_ms, range_end_ms, output_url, watermark_output_url, duration_ms, content_md5,"
    " sentences, error_code, error_message, created_at, finished_at)"
    " VALUES (:id, :owner, :conversation, :kind, :operation, :provider,"
    " CAST(:request AS jsonb), :status, :source, :root, :shot, :source_url, :range_start_ms,"
    " :range_end_ms, :output_url, :watermark_output_url, :duration_ms, :content_md5,"
    " CAST(:sentences AS jsonb), :error_code, :error_message, now(),"
    " CASE WHEN :status IN ('completed', 'failed') THEN now() END)"
)

_ROWS = text("SELECT id, to_jsonb(g) AS row FROM iclip.generation_jobs g ORDER BY id")

_INDEXES = text(
    "SELECT indexname, indexdef FROM pg_indexes"
    " WHERE schemaname = 'iclip' AND tablename = 'generation_jobs'"
)

_COLUMNS = text(
    "SELECT column_name FROM information_schema.columns"
    " WHERE table_schema = 'iclip' AND table_name = 'generation_jobs'"
)

SENTENCES = [
    {"start_ms": 0, "end_ms": 900, "text": "好。", "speaker": None, "words": []},
    {
        "start_ms": 900,
        "end_ms": 1500,
        "text": "走",
        "speaker": 0,
        "words": [{"start_ms": 900, "end_ms": 1500, "text": "走", "punctuation": ""}],
    },
]

VIDEO_REQUEST = {"model": "m", "prompt": "p", "user_name": "logan", "seconds": 5}
IMAGE_REQUEST = {"prompt": "p", "userName": "logan", "aspectRatio": "1:1", "resolution": "1k"}


@dataclass
class Row:
    """一行旧结构的记录，与升级后该有的 output、request 新增键与 provider。"""

    kind: str
    operation: str
    provider: str
    status: str = "completed"
    request: dict[str, Any] | None = None
    source: str | None = None
    root: str | None = None
    columns: dict[str, Any] = field(default_factory=dict[str, Any])
    output: dict[str, Any] | None = None
    request_added: dict[str, Any] = field(default_factory=dict[str, Any])
    id: uuid.UUID = field(default_factory=uuid.uuid4)


def _rows() -> dict[str, Row]:
    """每种记录一行；``source`` / ``root`` 指同表里的另一行。"""

    return {
        "出片": Row(
            "video",
            "generate",
            "video_api",
            request=VIDEO_REQUEST,
            columns={
                "shot": 1,
                "output_url": "https://cdn.test/take.mp4",
                "watermark_output_url": "https://cdn.test/take-wm.mp4",
                "duration_ms": 5000,
            },
            output={
                "url": "https://cdn.test/take.mp4",
                "watermark_url": "https://cdn.test/take-wm.mp4",
                "duration_ms": 5000,
            },
        ),
        "编辑段": Row(
            "video",
            "generate",
            "video_api",
            request=VIDEO_REQUEST,
            source="出片",
            root="出片",
            columns={
                "shot": 1,
                "range_start_ms": 1000,
                "range_end_ms": 4000,
                "output_url": "https://cdn.test/edit.mp4",
                "watermark_output_url": "https://cdn.test/edit-wm.mp4",
            },
            output={
                "url": "https://cdn.test/edit.mp4",
                "watermark_url": "https://cdn.test/edit-wm.mp4",
            },
            request_added={"range_start_ms": 1000, "range_end_ms": 4000},
        ),
        "合成": Row(
            "video",
            "compose",
            "ffmpeg",
            request={"segments": [{"url": "https://cdn.test/edit.mp4", "start": 0, "end": None}]},
            source="出片",
            root="出片",
            columns={"shot": 1, "output_url": "https://cdn.test/master.mp4", "duration_ms": 7040},
            output={"url": "https://cdn.test/master.mp4", "duration_ms": 7040},
        ),
        "超分": Row(
            "video",
            "enhance",
            "video_api",
            request={"model": "e", "resolution": "1080p", "video_url": "https://cdn.test/take.mp4"},
            source="出片",
            columns={
                "output_url": "https://cdn.test/hd.mp4",
                "watermark_output_url": "https://cdn.test/hd-wm.mp4",
            },
            output={
                "url": "https://cdn.test/hd.mp4",
                "watermark_url": "https://cdn.test/hd-wm.mp4",
            },
        ),
        "生图": Row(
            "image",
            "generate",
            "nano_banana_pro",
            request=IMAGE_REQUEST,
            columns={"output_url": "https://cdn.test/grid.png"},
            output={"url": "https://cdn.test/grid.png"},
        ),
        "帧图编辑（库里底图）": Row(
            "image",
            "generate",
            "nano_banana_pro",
            request=IMAGE_REQUEST,
            source="生图",
            columns={"output_url": "https://cdn.test/frame.png"},
            output={"url": "https://cdn.test/frame.png"},
        ),
        "帧图编辑（外部底图）": Row(
            "image",
            "generate",
            "nano_banana_pro",
            request=IMAGE_REQUEST,
            columns={
                "source_url": "https://elsewhere.test/base.png",
                "output_url": "https://cdn.test/frame-ext.png",
            },
            output={"url": "https://cdn.test/frame-ext.png"},
            request_added={"sourceUrl": "https://elsewhere.test/base.png"},
        ),
        "切图": Row(
            "image",
            "cut",
            "cut",
            source="生图",
            columns={"output_url": "https://cdn.test/cell.png"},
            output={"url": "https://cdn.test/cell.png"},
        ),
        "图片上传": Row(
            "image",
            "upload",
            "upload",
            columns={"output_url": "https://cdn.test/up.png"},
            output={"url": "https://cdn.test/up.png"},
        ),
        "视频上传": Row(
            "video",
            "upload",
            "upload",
            columns={"output_url": "https://cdn.test/clip.mp4", "content_md5": "a" * 32},
            output={"url": "https://cdn.test/clip.mp4", "content_md5": "a" * 32},
        ),
        "音乐上传": Row(
            "audio",
            "upload",
            "upload",
            columns={"output_url": "https://cdn.test/song.mp3"},
            output={"url": "https://cdn.test/song.mp3"},
        ),
        "生成音乐": Row(
            "audio",
            "generate",
            "qwen_music",
            request={"model": "m", "prompt": "轻快"},
            columns={"output_url": "https://cdn.test/music.wav", "duration_ms": 30_000},
            output={"url": "https://cdn.test/music.wav", "duration_ms": 30_000},
        ),
        "字幕": Row(
            "subtitle",
            "generate",
            "qwen_asr",
            request={"model": "asr", "videoUrl": "https://cdn.test/take.mp4"},
            source="出片",
            columns={"sentences": SENTENCES},
            output={"sentences": SENTENCES},
        ),
        "没有口播的字幕": Row(
            "subtitle",
            "generate",
            "qwen_asr",
            request={"model": "asr", "videoUrl": "https://cdn.test/take.mp4"},
            source="出片",
            columns={"sentences": []},
            output={"sentences": []},
        ),
        "成片": Row(
            "whole_film",
            "render",
            "whole_film_render",
            request={"revision": 1, "document": {}, "videos": [], "music": None, "subtitles": []},
            columns={"output_url": "https://cdn.test/film.mp4"},
            output={"url": "https://cdn.test/film.mp4"},
        ),
        "失败的出片": Row(
            "video",
            "generate",
            "video_api",
            status="failed",
            request=VIDEO_REQUEST,
            columns={"error_code": "UPSTREAM_FAILED", "error_message": "上游拒了"},
        ),
        "未完成的出片": Row(
            "video", "generate", "video_api", status="submitted", request=VIDEO_REQUEST
        ),
    }


async def _seed(url: str, rows: dict[str, Row]) -> None:
    engine = build_engine(url, poolclass=NullPool)
    try:
        owner = await make_user(engine)
        async with engine.begin() as conn:
            for row in rows.values():
                columns = dict(row.columns)
                sentences = columns.pop("sentences", None)
                await conn.execute(
                    _INSERT,
                    {
                        "id": row.id,
                        "owner": owner,
                        "conversation": None,
                        "kind": row.kind,
                        "operation": row.operation,
                        "provider": row.provider,
                        "request": None if row.request is None else json.dumps(row.request),
                        "status": row.status,
                        "source": None if row.source is None else rows[row.source].id,
                        "root": None if row.root is None else rows[row.root].id,
                        "shot": None,
                        "source_url": None,
                        "range_start_ms": None,
                        "range_end_ms": None,
                        "output_url": None,
                        "watermark_output_url": None,
                        "duration_ms": None,
                        "content_md5": None,
                        "error_code": None,
                        "error_message": None,
                        **columns,
                        "sentences": None if sentences is None else json.dumps(sentences),
                    },
                )
    finally:
        await engine.dispose()


async def _snapshot(url: str) -> dict[str, Any]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = {row.id: row.row for row in await conn.execute(_ROWS)}
            indexes = {row.indexname: row.indexdef for row in await conn.execute(_INDEXES)}
            columns = set((await conn.execute(_COLUMNS)).scalars())
        return {"rows": rows, "indexes": indexes, "columns": columns}
    finally:
        await engine.dispose()


def test_upgrade_moves_each_kinds_own_fields_and_downgrade_restores_everything(
    scratch_db: str,
) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    rows = _rows()
    asyncio.run(_seed(scratch_db, rows))
    before = asyncio.run(_snapshot(scratch_db))

    command.upgrade(cfg, AFTER)

    after = asyncio.run(_snapshot(scratch_db))
    moved = {
        "output_url",
        "watermark_output_url",
        "duration_ms",
        "content_md5",
        "sentences",
        "source_url",
        "range_start_ms",
        "range_end_ms",
    }
    assert after["columns"] == (before["columns"] - moved) | {"output"}
    for name, row in rows.items():
        old, new = before["rows"][row.id], after["rows"][row.id]
        assert new["output"] == row.output, name
        expected_request = None if row.request is None else {**row.request, **row.request_added}
        assert new["request"] == expected_request, name
        expected_provider = None if row.operation in ("upload", "cut") else row.provider
        assert new["provider"] == expected_provider, name
        untouched = set(old) - moved - {"request", "provider"}
        assert {key: new[key] for key in untouched} == {key: old[key] for key in untouched}, name
    assert set(after["indexes"]) == {
        "generation_jobs_pkey",
        "ix_generation_jobs_owner_created",
        "ix_generation_jobs_conversation_kind_created",
        "ix_generation_jobs_task_created",
        "ix_generation_jobs_root_job",
        "ix_generation_jobs_source_job",
        "ix_generation_jobs_conversation_shot",
        "ix_generation_jobs_masters",
        "ix_generation_jobs_whole_films",
        "ix_generation_jobs_unfinished",
        "ix_generation_jobs_output_url",
        "ix_generation_jobs_video_upload_md5",
        "ix_generation_jobs_reference_trial",
    }

    command.downgrade(cfg, BEFORE)

    assert asyncio.run(_snapshot(scratch_db)) == before


@pytest.mark.parametrize(
    "broken",
    [
        {"range_start_ms": 1000, "range_end_ms": 4000},
        {"source_url": "https://elsewhere.test/base.png"},
    ],
    ids=["区间搬不进没有请求的行", "外部底图搬不进没有请求的行"],
)
def test_a_row_that_cannot_be_moved_rolls_the_whole_migration_back(
    scratch_db: str, broken: dict[str, Any]
) -> None:
    """请求为空的行装不下区间或外部底图：核对不过，整个迁移回滚，表还是 0038 的样子。"""

    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    rows = {"坏行": Row("video", "generate", "video_api", request=None, columns=broken)}
    asyncio.run(_seed(scratch_db, rows))
    before = asyncio.run(_snapshot(scratch_db))

    with pytest.raises(Exception, match="没把"):
        command.upgrade(cfg, AFTER)

    assert asyncio.run(_snapshot(scratch_db)) == before
