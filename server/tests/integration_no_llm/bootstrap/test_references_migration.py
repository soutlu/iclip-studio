from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from iclip.domains.references.infra_sql import SqlReferenceStore
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.pg import connected, reset_database
from tests.helpers.tagging import entry_of, plant_entry, tag_id

SERVER_DIR = Path(__file__).resolve().parents[3]

BEFORE_REFERENCES = "b4e81c6d0f27"

STAMP = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)

VIDEO_A = "https://cdn.test/iclip/agent/uploads/a.mp4"
VIDEO_B = "https://cdn.test/iclip/agent/uploads/b.mp4"
VIDEO_C = "https://cdn.test/iclip/agent/uploads/c.mp4"
VOICE = "https://cdn.test/iclip/agent/uploads/voice.m4a"


def _alembic(url: str) -> AlembicConfig:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = url
    return config


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


_INSERT_JOB = text(
    "INSERT INTO iclip.generation_jobs"
    " (id, owner_user_id, kind, operation, provider, request, status, source_job_id, output,"
    "  metadata, created_at, finished_at)"
    " VALUES (:id, :owner, :kind, :operation, 'video_api', CAST(:request AS jsonb), 'completed',"
    "  :source, CAST(:output AS jsonb), CAST(:metadata AS jsonb), :at, :at)"
)

_INSERT_OLD_REFERENCE = text(
    "INSERT INTO iclip.reference_videos"
    " (id, video_url, owner_user_id, breakdown_status, error_code, document, version,"
    "  requested_by, api_key_id, created_at, updated_at, deleted_at)"
    " VALUES (:id, :url, :owner, :status, NULL, :document, :version, :owner, NULL, :at, :at,"
    "  :deleted_at)"
)

_INSERT_UPLOAD = text(
    "INSERT INTO iclip.media_uploads (id, owner_user_id, kind, url, created_at)"
    " VALUES (:id, :owner, :kind, :url, :at)"
)

_VIDEO_REQUEST = {"model": "m", "prompt": "p", "user_name": "nora", "seconds": 5}


@dataclass(frozen=True, slots=True)
class Planted:
    owner: uuid.UUID
    other: uuid.UUID
    a: uuid.UUID
    b: uuid.UUID
    c: uuid.UUID
    video_upload: uuid.UUID
    voice_upload: uuid.UUID
    take: uuid.UUID
    older_trial: uuid.UUID
    newer_trial: uuid.UUID
    edit: uuid.UUID
    dubbing: uuid.UUID
    tag: uuid.UUID


async def _job(
    conn: AsyncConnection,
    job_id: uuid.UUID,
    owner: uuid.UUID,
    *,
    minutes: int,
    kind: str = "video",
    request: dict[str, Any] | None = None,
    source: uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    await conn.execute(
        _INSERT_JOB,
        {
            "id": job_id,
            "owner": owner,
            "kind": kind,
            "operation": "generate",
            "request": json.dumps(request or _VIDEO_REQUEST),
            "source": source,
            "output": json.dumps({"url": f"https://cdn.test/{job_id}.mp4"}),
            "metadata": None if metadata is None else json.dumps(metadata),
            "at": STAMP + timedelta(minutes=minutes),
        },
    )


async def _plant_old_shape(url: str) -> Planted:
    """在分表之前的版本上种旧形状的参考视频、试生成、带标签的条目与按地址给参考音频的配音。"""

    engine = build_engine(url)
    try:
        owner, other = await make_user(engine), await make_user(engine)
        a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        video_upload, voice_upload = uuid.uuid4(), uuid.uuid4()
        take, older_trial, newer_trial, edit, dubbing = (uuid.uuid4() for _ in range(5))
        async with engine.begin() as conn:
            for upload_id, kind, upload_url in (
                (video_upload, "video", VIDEO_A),
                (voice_upload, "audio", VOICE),
            ):
                await conn.execute(
                    _INSERT_UPLOAD,
                    {"id": upload_id, "owner": owner, "kind": kind, "url": upload_url, "at": STAMP},
                )
            for reference_id, reference_url, who, status, document, deleted in (
                (a, VIDEO_A, owner, "completed", "# 拆解 A", None),
                (b, VIDEO_B, owner, "completed", "# 拆解 B", STAMP + timedelta(days=1)),
                (c, VIDEO_C, other, "pending", None, None),
            ):
                await conn.execute(
                    _INSERT_OLD_REFERENCE,
                    {
                        "id": reference_id,
                        "url": reference_url,
                        "owner": who,
                        "status": status,
                        "document": document,
                        "version": 2 if document else 1,
                        "at": STAMP,
                        "deleted_at": deleted,
                    },
                )
            tag = {"referenceId": str(a)}
            await _job(conn, take, owner, minutes=1)
            await _job(conn, older_trial, owner, minutes=2, metadata=tag)
            await _job(conn, newer_trial, other, minutes=3, metadata=tag)
            await _job(
                conn,
                edit,
                owner,
                minutes=4,
                request={**_VIDEO_REQUEST, "range_start_ms": 0, "range_end_ms": 1000},
                source=take,
                metadata=tag,
            )
            await _job(
                conn,
                dubbing,
                owner,
                minutes=5,
                kind="dubbing",
                request={
                    "videoUrl": f"https://cdn.test/{take}.mp4",
                    "videoDurationMs": 5000,
                    "locale": "en",
                    "lines": [{"startMs": 0, "endMs": 1000, "text": "Hi"}],
                    "reference": {"kind": "audio", "url": VOICE},
                },
                source=take,
            )
        runner = await tag_id(engine, "品类", "跑鞋")
        await plant_entry(engine, a, status="completed", tags=[runner], created_by=owner)
        return Planted(
            owner=owner,
            other=other,
            a=a,
            b=b,
            c=c,
            video_upload=video_upload,
            voice_upload=voice_upload,
            take=take,
            older_trial=older_trial,
            newer_trial=newer_trial,
            edit=edit,
            dubbing=dubbing,
            tag=runner,
        )
    finally:
        await engine.dispose()


async def _rows(conn: AsyncConnection, sql: str, **params: Any) -> list[dict[str, Any]]:
    return [dict(row) for row in (await conn.execute(text(sql), params)).mappings()]


async def _exists(conn: AsyncConnection, name: str) -> bool:
    found = await conn.execute(text("SELECT to_regclass(:name) IS NOT NULL"), {"name": name})
    return bool(found.scalar_one())


async def _operations(conn: AsyncConnection, planted: Planted) -> dict[uuid.UUID, str]:
    rows = await _rows(
        conn,
        "SELECT id, operation FROM iclip.generation_jobs WHERE id = ANY(CAST(:ids AS uuid[]))",
        ids=[planted.take, planted.older_trial, planted.newer_trial, planted.edit],
    )
    return {row["id"]: row["operation"] for row in rows}


async def _report(conn: AsyncConnection) -> list[dict[str, Any]]:
    return await _rows(conn, "SELECT * FROM iclip.video_generation_report ORDER BY started_at")


async def _report_ids(url: str) -> set[uuid.UUID]:
    async with connected(url) as conn:
        return {row["job_id"] for row in await _report(conn)}


async def _dubbing_reference(conn: AsyncConnection, planted: Planted) -> Any:
    found = await conn.execute(
        text("SELECT request -> 'reference' FROM iclip.generation_jobs WHERE id = :id"),
        {"id": planted.dubbing},
    )
    return found.scalar_one()


@dataclass(frozen=True, slots=True)
class Upgraded:
    references: list[dict[str, Any]]
    videos: list[dict[str, Any]]
    operations: dict[uuid.UUID, str]
    report: list[dict[str, Any]]
    tags: set[uuid.UUID]
    dubbing_reference: Any
    a_read_back: tuple[str, uuid.UUID | None, str | None] | None
    legacy_left: bool
    trial_index_left: bool


async def _read_upgraded(url: str, planted: Planted) -> Upgraded:
    engine = build_engine(url)
    try:
        read = await SqlReferenceStore(engine).get(planted.a)
        tags = (await entry_of(engine, planted.a))["tags"]
        async with engine.connect() as conn:
            references = await _rows(
                conn,
                "SELECT id, kind, title, url, owner_user_id, upload_id, source_job_id,"
                " deleted_at FROM iclip.references ORDER BY url",
            )
            videos = await _rows(
                conn,
                "SELECT reference_id, breakdown_status, document, version, requested_by,"
                " test_job_id FROM iclip.reference_videos ORDER BY reference_id",
            )
            upgraded = Upgraded(
                references=references,
                videos=videos,
                operations=await _operations(conn, planted),
                report=await _report(conn),
                tags=tags,
                dubbing_reference=await _dubbing_reference(conn, planted),
                a_read_back=None
                if read is None
                else (read.video_url, read.test_job_id, read.document),
                legacy_left=await _exists(conn, "iclip.reference_videos_legacy"),
                trial_index_left=await _exists(conn, "iclip.ix_generation_jobs_reference_trial"),
            )
    finally:
        await engine.dispose()
    return upgraded


@dataclass(frozen=True, slots=True)
class AfterUpgrade:
    new_trial: uuid.UUID
    export: uuid.UUID
    with_ids: uuid.UUID


async def _write_new_shapes(url: str, planted: Planted) -> AfterUpgrade:
    """升级以后才有的写法：没有 referenceId 的试生成、参考音频、对上参考音频库的配乐与 reference_ids。"""

    new_trial, export, with_ids, audio = (uuid.uuid4() for _ in range(4))
    async with connected(url) as conn:
        await conn.execute(
            _INSERT_JOB,
            {
                "id": new_trial,
                "owner": planted.owner,
                "kind": "video",
                "operation": "trial",
                "request": json.dumps(_VIDEO_REQUEST),
                "source": None,
                "output": json.dumps({"url": "https://cdn.test/new-trial.mp4"}),
                "metadata": None,
                "at": STAMP + timedelta(days=2),
            },
        )
        await conn.execute(
            text("UPDATE iclip.reference_videos SET test_job_id = :job WHERE reference_id = :id"),
            {"job": new_trial, "id": planted.c},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.references (id, kind, title, url, duration_ms, owner_user_id)"
                " VALUES (:id, 'audio', '音色', :url, 5000, :owner)"
            ),
            {"id": audio, "url": VOICE, "owner": planted.owner},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.reference_audios (reference_id, audio_kind)"
                " VALUES (:id, 'voice')"
            ),
            {"id": audio},
        )
        audios = [
            {"sourceKind": "upload", "sourceId": str(planted.voice_upload), "url": VOICE},
            {"sourceKind": "reference", "sourceId": str(audio), "url": VOICE},
        ]
        await conn.execute(
            _INSERT_JOB,
            {
                "id": export,
                "owner": planted.owner,
                "kind": "whole_film",
                "operation": "render",
                "request": json.dumps({"videos": [], "audios": audios}),
                "source": None,
                "output": json.dumps({"url": "https://cdn.test/film.mp4"}),
                "metadata": None,
                "at": STAMP + timedelta(days=2),
            },
        )
        await conn.execute(
            _INSERT_JOB,
            {
                "id": with_ids,
                "owner": planted.owner,
                "kind": "video",
                "operation": "generate",
                "request": json.dumps({**_VIDEO_REQUEST, "reference_ids": [str(audio)]}),
                "source": None,
                "output": json.dumps({"url": "https://cdn.test/with-ids.mp4"}),
                "metadata": None,
                "at": STAMP + timedelta(days=2),
            },
        )
    return AfterUpgrade(new_trial=new_trial, export=export, with_ids=with_ids)


@dataclass(frozen=True, slots=True)
class Downgraded:
    references: list[dict[str, Any]]
    operations: dict[uuid.UUID, str]
    report: list[dict[str, Any]]
    tags: set[uuid.UUID]
    dubbing_reference: Any
    new_trial: dict[str, Any]
    export_audios: Any
    with_ids_request: Any
    split_left: bool
    trial_index_back: bool
    foreign_key_back: bool


async def _read_downgraded(url: str, planted: Planted, later: AfterUpgrade) -> Downgraded:
    engine = build_engine(url)
    try:
        tags = (await entry_of(engine, planted.a))["tags"]
        async with engine.connect() as conn:
            (new_trial,) = await _rows(
                conn,
                "SELECT operation, metadata FROM iclip.generation_jobs WHERE id = :id",
                id=later.new_trial,
            )
            (export,) = await _rows(
                conn,
                "SELECT request -> 'audios' AS audios FROM iclip.generation_jobs WHERE id = :id",
                id=later.export,
            )
            (with_ids,) = await _rows(
                conn, "SELECT request FROM iclip.generation_jobs WHERE id = :id", id=later.with_ids
            )
            foreign_key = await conn.execute(
                text(
                    "SELECT count(*) FROM pg_constraint"
                    " WHERE conname = 'library_entries_reference_id_fkey'"
                )
            )
            downgraded = Downgraded(
                references=await _rows(
                    conn,
                    "SELECT id, video_url, owner_user_id, breakdown_status, document, version,"
                    " requested_by, deleted_at FROM iclip.reference_videos ORDER BY video_url",
                ),
                operations=await _operations(conn, planted),
                report=await _report(conn),
                tags=tags,
                dubbing_reference=await _dubbing_reference(conn, planted),
                new_trial=new_trial,
                export_audios=export["audios"],
                with_ids_request=with_ids["request"],
                split_left=await _exists(conn, 'iclip."references"'),
                trial_index_back=await _exists(conn, "iclip.ix_generation_jobs_reference_trial"),
                foreign_key_back=foreign_key.scalar_one() == 1,
            )
    finally:
        await engine.dispose()
    return downgraded


def test_reference_videos_split_into_the_main_and_video_tables_and_back(migrated_pg: str) -> None:
    config = _alembic(migrated_pg)
    asyncio.run(_reset(migrated_pg))

    command.downgrade(config, BEFORE_REFERENCES)
    try:
        planted = asyncio.run(_plant_old_shape(migrated_pg))
        report_before = asyncio.run(_report_ids(migrated_pg))
        command.upgrade(config, "head")
        upgraded = asyncio.run(_read_upgraded(migrated_pg, planted))
        later = asyncio.run(_write_new_shapes(migrated_pg, planted))
        command.downgrade(config, BEFORE_REFERENCES)
        downgraded = asyncio.run(_read_downgraded(migrated_pg, planted, later))
    finally:
        command.upgrade(config, "head")

    assert upgraded.references == [
        {
            "id": planted.a,
            "kind": "video",
            "title": "",
            "url": VIDEO_A,
            "owner_user_id": planted.owner,
            "upload_id": planted.video_upload,
            "source_job_id": None,
            "deleted_at": None,
        },
        {
            "id": planted.b,
            "kind": "video",
            "title": "",
            "url": VIDEO_B,
            "owner_user_id": planted.owner,
            "upload_id": None,
            "source_job_id": None,
            "deleted_at": STAMP + timedelta(days=1),
        },
        {
            "id": planted.c,
            "kind": "video",
            "title": "",
            "url": VIDEO_C,
            "owner_user_id": planted.other,
            "upload_id": None,
            "source_job_id": None,
            "deleted_at": None,
        },
    ], "原 id 不变；来源取同一属主同一地址的视频上传，对不上为空；软删的照旧软删"
    assert {row["reference_id"]: row for row in upgraded.videos} == {
        planted.a: {
            "reference_id": planted.a,
            "breakdown_status": "completed",
            "document": "# 拆解 A",
            "version": 2,
            "requested_by": planted.owner,
            "test_job_id": planted.newer_trial,
        },
        planted.b: {
            "reference_id": planted.b,
            "breakdown_status": "completed",
            "document": "# 拆解 B",
            "version": 2,
            "requested_by": planted.owner,
            "test_job_id": None,
        },
        planted.c: {
            "reference_id": planted.c,
            "breakdown_status": "pending",
            "document": None,
            "version": 1,
            "requested_by": planted.other,
            "test_job_id": None,
        },
    }, "test_job_id 是这条参考视频最新的一次试生成，不论谁发起"
    assert upgraded.operations == {
        planted.take: "generate",
        planted.older_trial: "trial",
        planted.newer_trial: "trial",
        planted.edit: "generate",
    }, "带 referenceId 的出片改成试生成；编辑段不动"
    assert upgraded.tags == {planted.tag}, "标签零丢失"
    assert upgraded.dubbing_reference == {
        "kind": "upload",
        "uploadId": str(planted.voice_upload),
        "url": VOICE,
    }
    assert upgraded.a_read_back == (VIDEO_A, planted.newer_trial, "# 拆解 A")
    assert (upgraded.legacy_left, upgraded.trial_index_left) == (False, False)
    assert report_before == {planted.take, planted.older_trial, planted.newer_trial}
    assert {row["job_id"] for row in upgraded.report} == report_before
    assert [(row["job_id"], row["trial"]) for row in upgraded.report] == [
        (planted.take, False),
        (planted.older_trial, True),
        (planted.newer_trial, True),
    ], "报表的条数和升级前一样，试生成单列标出"

    assert downgraded.references == [
        {
            "id": planted.a,
            "video_url": VIDEO_A,
            "owner_user_id": planted.owner,
            "breakdown_status": "completed",
            "document": "# 拆解 A",
            "version": 2,
            "requested_by": planted.owner,
            "deleted_at": None,
        },
        {
            "id": planted.b,
            "video_url": VIDEO_B,
            "owner_user_id": planted.owner,
            "breakdown_status": "completed",
            "document": "# 拆解 B",
            "version": 2,
            "requested_by": planted.owner,
            "deleted_at": STAMP + timedelta(days=1),
        },
        {
            "id": planted.c,
            "video_url": VIDEO_C,
            "owner_user_id": planted.other,
            "breakdown_status": "pending",
            "document": None,
            "version": 1,
            "requested_by": planted.other,
            "deleted_at": None,
        },
    ]
    assert set(downgraded.operations.values()) == {"generate"}
    assert downgraded.tags == {planted.tag}
    assert downgraded.dubbing_reference == {"kind": "audio", "url": VOICE}
    assert downgraded.new_trial == {
        "operation": "generate",
        "metadata": {"referenceId": str(planted.c)},
    }, "升级后发起的最新一次试生成补上 referenceId"
    assert downgraded.export_audios == [
        {"sourceKind": "upload", "sourceId": str(planted.voice_upload), "url": VOICE}
    ], "对上参考音频库的配乐条目丢掉"
    assert "reference_ids" not in downgraded.with_ids_request
    assert {row["job_id"] for row in downgraded.report} == {
        planted.take,
        planted.older_trial,
        planted.newer_trial,
        later.new_trial,
        later.with_ids,
    }, "试生成降回出片，照旧在报表里"
    assert all("trial" not in row for row in downgraded.report)
    assert downgraded.split_left is False, "参考音频与主表都删了"
    assert (downgraded.trial_index_back, downgraded.foreign_key_back) == (True, True)


async def _plant_unmatched_dubbing(url: str) -> uuid.UUID:
    engine = build_engine(url)
    try:
        owner = await make_user(engine)
        dubbing = uuid.uuid4()
        async with engine.begin() as conn:
            await _job(
                conn,
                dubbing,
                owner,
                minutes=0,
                kind="dubbing",
                request={
                    "videoUrl": "https://cdn.test/take.mp4",
                    "videoDurationMs": 5000,
                    "locale": "en",
                    "lines": [{"startMs": 0, "endMs": 1000, "text": "Hi"}],
                    "reference": {"kind": "audio", "url": "https://cdn.test/nowhere.m4a"},
                },
            )
        return dubbing
    finally:
        await engine.dispose()


async def _drop_job(url: str, job_id: uuid.UUID) -> None:
    async with connected(url) as conn:
        await conn.execute(text("DELETE FROM iclip.generation_jobs WHERE id = :id"), {"id": job_id})


def test_a_dubbing_whose_reference_matches_no_audio_upload_stops_the_migration(
    migrated_pg: str,
) -> None:
    config = _alembic(migrated_pg)
    asyncio.run(_reset(migrated_pg))

    command.downgrade(config, BEFORE_REFERENCES)
    dubbing = asyncio.run(_plant_unmatched_dubbing(migrated_pg))
    try:
        with pytest.raises(RuntimeError, match="1 条配音记录的参考音频对不上"):
            command.upgrade(config, "head")
    finally:
        asyncio.run(_drop_job(migrated_pg, dubbing))
        command.upgrade(config, "head")
