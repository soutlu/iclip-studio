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

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.schemas import (
    ImageGenerationIn,
    WholeFilmAudioSource,
    WholeFilmRequest,
    request_to_payload,
)
from iclip.domains.uploads.infra_sql import SqlUploadRepository
from iclip.domains.uploads.models import MediaUpload
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.generation import image_request
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[3]

BEFORE_UPLOADS = "c84e19a3b502"

MD5 = "0123456789abcdef0123456789abcdef"

EXTERNAL_BASE = "https://img.example.test/look.png"

STAMP = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)


def _alembic(url: str) -> AlembicConfig:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = url
    return config


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


@dataclass(frozen=True, slots=True)
class Planted:
    owner: uuid.UUID
    conversation: uuid.UUID
    image: uuid.UUID
    video: uuid.UUID
    music: uuid.UUID
    take: uuid.UUID
    edit_on_upload: uuid.UUID
    edit_on_link: uuid.UUID
    export: uuid.UUID
    upload_download: uuid.UUID
    take_download: uuid.UUID


def _upload_url(upload_id: uuid.UUID, ext: str) -> str:
    return f"https://cdn.test/iclip/agent/uploads/{upload_id}.{ext}"


TAKE_AUDIO = "https://cdn.test/take.mp4"


def _old_audios(music: uuid.UUID, take: uuid.UUID) -> list[dict[str, str]]:
    """改之前的成片导出记录里的配乐：一条上传的音乐，一条素材片分离出来的原声。"""

    return [
        {"jobId": str(music), "url": _upload_url(music, "m4a")},
        {"jobId": str(take), "url": TAKE_AUDIO},
    ]


_INSERT_JOB = text(
    "INSERT INTO iclip.generation_jobs"
    " (id, owner_user_id, conversation_id, kind, operation, provider, request, status,"
    "  source_job_id, output, created_at, finished_at)"
    " VALUES (:id, :owner, :conversation, :kind, :operation, :provider,"
    "  CAST(:request AS jsonb), 'completed', :source, CAST(:output AS jsonb), :at, :at)"
)

_INSERT_DOWNLOAD = text(
    "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at)"
    " VALUES (:id, 'video.downloaded', :job, :user, now())"
)


async def _plant_old_shape(url: str) -> Planted:
    """在拆表之前的版本上种旧形状的上传记录、以上传为基底的改图与指着上传的下载事件。"""

    engine = build_engine(url)
    try:
        owner = await make_user(engine)
        conversation = (await open_conversation(SqlConversationRepository(engine), owner)).id
        image, video, music, take = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        edit_on_upload, edit_on_link, export = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        upload_download, take_download = uuid.uuid4(), uuid.uuid4()
        uploads = (
            (image, "image", None, {"url": _upload_url(image, "png")}, 0),
            (video, "video", None, {"url": _upload_url(video, "mp4"), "content_md5": MD5}, 1),
            (music, "audio", conversation, {"url": _upload_url(music, "m4a")}, 2),
        )
        async with engine.begin() as conn:
            for upload_id, kind, conversation_id, output, minutes in uploads:
                await conn.execute(
                    _INSERT_JOB,
                    {
                        "id": upload_id,
                        "owner": owner,
                        "conversation": conversation_id,
                        "kind": kind,
                        "operation": "upload",
                        "provider": None,
                        "request": None,
                        "source": None,
                        "output": json.dumps(output),
                        "at": STAMP + timedelta(minutes=minutes),
                    },
                )
            await conn.execute(
                _INSERT_JOB,
                {
                    "id": take,
                    "owner": owner,
                    "conversation": conversation,
                    "kind": "video",
                    "operation": "generate",
                    "provider": "video_api",
                    "request": json.dumps({"model": "m", "prompt": "p", "user_name": "nora"}),
                    "source": None,
                    "output": json.dumps({"url": "https://cdn.test/take.mp4"}),
                    "at": STAMP,
                },
            )
            for edit_id, source, link in (
                (edit_on_upload, image, None),
                (edit_on_link, None, EXTERNAL_BASE),
            ):
                await conn.execute(
                    _INSERT_JOB,
                    {
                        "id": edit_id,
                        "owner": owner,
                        "conversation": conversation,
                        "kind": "image",
                        "operation": "generate",
                        "provider": "nano_banana_pro",
                        "request": json.dumps(request_to_payload(image_request(source_url=link))),
                        "source": source,
                        "output": json.dumps({"url": f"https://cdn.test/{edit_id}.png"}),
                        "at": STAMP + timedelta(minutes=5),
                    },
                )
            await conn.execute(
                _INSERT_JOB,
                {
                    "id": export,
                    "owner": owner,
                    "conversation": conversation,
                    "kind": "whole_film",
                    "operation": "render",
                    "provider": "final_cut_render",
                    "request": json.dumps({"videos": [], "audios": _old_audios(music, take)}),
                    "source": None,
                    "output": json.dumps({"url": "https://cdn.test/film.mp4"}),
                    "at": STAMP + timedelta(minutes=10),
                },
            )
            for event, job in ((upload_download, video), (take_download, take)):
                await conn.execute(_INSERT_DOWNLOAD, {"id": event, "job": job, "user": owner})
        return Planted(
            owner=owner,
            conversation=conversation,
            image=image,
            video=video,
            music=music,
            take=take,
            edit_on_upload=edit_on_upload,
            edit_on_link=edit_on_link,
            export=export,
            upload_download=upload_download,
            take_download=take_download,
        )
    finally:
        await engine.dispose()


@dataclass(frozen=True, slots=True)
class Upgraded:
    uploads: list[MediaUpload]
    upload_jobs: int
    edit_on_upload: tuple[uuid.UUID | None, str | None]
    edit_on_link: tuple[uuid.UUID | None, str | None]
    export_audios: list[WholeFilmAudioSource]
    events: set[uuid.UUID]
    md5_index: bool


async def _md5_index(conn: Any) -> bool:
    found = await conn.execute(
        text("SELECT to_regclass('iclip.ix_generation_jobs_video_upload_md5') IS NOT NULL")
    )
    return bool(found.scalar_one())


async def _events(conn: Any) -> set[uuid.UUID]:
    return {row[0] for row in await conn.execute(text("SELECT id FROM iclip.tracking_events"))}


async def _read_upgraded(url: str, planted: Planted) -> Upgraded:
    engine = build_engine(url)
    try:
        uploads = SqlUploadRepository(engine)
        found = [
            await uploads.get(upload_id)
            for upload_id in (planted.image, planted.video, planted.music)
        ]
        generations = SqlGenerationRepository(engine)
        edits: list[tuple[uuid.UUID | None, str | None]] = []
        for edit_id in (planted.edit_on_upload, planted.edit_on_link):
            edit = await generations.get(edit_id, owner=None)
            assert isinstance(edit.request, ImageGenerationIn)
            edits.append((edit.source_job_id, edit.request.source_url))
        export = (await generations.get(planted.export, owner=None)).request
        assert isinstance(export, WholeFilmRequest)
        async with engine.connect() as conn:
            upload_jobs = (
                await conn.execute(
                    text("SELECT count(*) FROM iclip.generation_jobs WHERE operation = 'upload'")
                )
            ).scalar_one()
            events = await _events(conn)
            md5_index = await _md5_index(conn)
    finally:
        await engine.dispose()
    return Upgraded(
        uploads=[upload for upload in found if upload is not None],
        upload_jobs=int(upload_jobs),
        edit_on_upload=edits[0],
        edit_on_link=edits[1],
        export_audios=export.audios,
        events=events,
        md5_index=md5_index,
    )


@dataclass(frozen=True, slots=True)
class Downgraded:
    upload_jobs: list[tuple[Any, ...]]
    edits: dict[uuid.UUID, tuple[uuid.UUID | None, str | None]]
    export_audios: Any
    events: set[uuid.UUID]
    md5_index: bool
    table_left: bool


async def _read_downgraded(url: str, planted: Planted) -> Downgraded:
    async with connected(url) as conn:
        upload_jobs = [
            tuple(row)
            for row in await conn.execute(
                text(
                    "SELECT id, owner_user_id, conversation_id, kind, status, request, output,"
                    " created_at, finished_at FROM iclip.generation_jobs"
                    " WHERE operation = 'upload' ORDER BY created_at"
                )
            )
        ]
        edits = {
            row[0]: (row[1], row[2])
            for row in await conn.execute(
                text(
                    "SELECT id, source_job_id, request ->> 'sourceUrl' FROM iclip.generation_jobs"
                    " WHERE kind = 'image' AND operation = 'generate'"
                )
            )
        }
        export_audios = (
            await conn.execute(
                text("SELECT request -> 'audios' FROM iclip.generation_jobs WHERE id = :id"),
                {"id": planted.export},
            )
        ).scalar_one()
        events = await _events(conn)
        md5_index = await _md5_index(conn)
        table_left = (
            await conn.execute(text("SELECT to_regclass('iclip.media_uploads') IS NOT NULL"))
        ).scalar_one()
    return Downgraded(
        upload_jobs=upload_jobs,
        edits=edits,
        export_audios=export_audios,
        events=events,
        md5_index=md5_index,
        table_left=bool(table_left),
    )


def test_uploads_move_into_their_own_ledger_and_back(migrated_pg: str) -> None:
    config = _alembic(migrated_pg)
    asyncio.run(_reset(migrated_pg))

    command.downgrade(config, BEFORE_UPLOADS)
    try:
        planted = asyncio.run(_plant_old_shape(migrated_pg))
        command.upgrade(config, "head")
        upgraded = asyncio.run(_read_upgraded(migrated_pg, planted))
        command.downgrade(config, BEFORE_UPLOADS)
        downgraded = asyncio.run(_read_downgraded(migrated_pg, planted))
    finally:
        command.upgrade(config, "head")

    assert [
        (
            upload.id,
            upload.owner_user_id,
            upload.conversation_id,
            upload.kind,
            upload.url,
            upload.content_type,
            upload.size_bytes,
            upload.duration_ms,
            upload.width,
            upload.content_md5,
            upload.created_at,
        )
        for upload in upgraded.uploads
    ] == [
        (
            planted.image,
            planted.owner,
            None,
            "image",
            _upload_url(planted.image, "png"),
            None,
            None,
            None,
            None,
            None,
            STAMP,
        ),
        (
            planted.video,
            planted.owner,
            None,
            "video",
            _upload_url(planted.video, "mp4"),
            None,
            None,
            None,
            None,
            MD5,
            STAMP + timedelta(minutes=1),
        ),
        (
            planted.music,
            planted.owner,
            planted.conversation,
            "audio",
            _upload_url(planted.music, "m4a"),
            None,
            None,
            None,
            None,
            None,
            STAMP + timedelta(minutes=2),
        ),
    ], "id 不变；内容类型、大小、宽高、时长旧记录里没有，留空"
    assert upgraded.upload_jobs == 0, "生成记录里不再有上传"
    assert upgraded.edit_on_upload == (None, _upload_url(planted.image, "png")), (
        "以上传为基底的改图改成外链基底的写法"
    )
    assert upgraded.edit_on_link == (None, EXTERNAL_BASE)
    assert upgraded.export_audios == [
        WholeFilmAudioSource(
            source_kind="upload", source_id=planted.music, url=_upload_url(planted.music, "m4a")
        ),
        WholeFilmAudioSource(source_kind="generation", source_id=planted.take, url=TAKE_AUDIO),
    ], "导出记录的配乐按 id 认出是上传还是生成记录，先后不变"
    assert upgraded.events == {planted.take_download}, "指着上传的下载事件删掉，别的留着"
    assert upgraded.md5_index is False

    assert downgraded.table_left is False
    assert downgraded.md5_index is True
    assert downgraded.upload_jobs == [
        (
            planted.image,
            planted.owner,
            None,
            "image",
            "completed",
            None,
            {"url": _upload_url(planted.image, "png")},
            STAMP,
            STAMP,
        ),
        (
            planted.video,
            planted.owner,
            None,
            "video",
            "completed",
            None,
            {"url": _upload_url(planted.video, "mp4"), "content_md5": MD5},
            STAMP + timedelta(minutes=1),
            STAMP + timedelta(minutes=1),
        ),
        (
            planted.music,
            planted.owner,
            planted.conversation,
            "audio",
            "completed",
            None,
            {"url": _upload_url(planted.music, "m4a")},
            STAMP + timedelta(minutes=2),
            STAMP + timedelta(minutes=2),
        ),
    ], "降回去按旧形状写回生成记录"
    assert downgraded.edits[planted.edit_on_upload] == (planted.image, None), (
        "改图重新指着那条上传，不再带 sourceUrl"
    )
    assert downgraded.edits[planted.edit_on_link] == (None, EXTERNAL_BASE)
    assert downgraded.export_audios == _old_audios(planted.music, planted.take)
    assert downgraded.events == {planted.take_download}, "删掉的下载事件回不来"


async def _plant_upload_with_a_derived_take(url: str) -> uuid.UUID:
    engine = build_engine(url)
    try:
        owner = await make_user(engine)
        upload, derived = uuid.uuid4(), uuid.uuid4()
        async with engine.begin() as conn:
            await conn.execute(
                _INSERT_JOB,
                {
                    "id": upload,
                    "owner": owner,
                    "conversation": None,
                    "kind": "video",
                    "operation": "upload",
                    "provider": None,
                    "request": None,
                    "source": None,
                    "output": json.dumps({"url": _upload_url(upload, "mp4")}),
                    "at": STAMP,
                },
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation, status,"
                    " root_job_id, created_at) VALUES (:id, :owner, 'video', 'compose', 'pending',"
                    " :root, now())"
                ),
                {"id": derived, "owner": owner, "root": upload},
            )
        return derived
    finally:
        await engine.dispose()


async def _drop_job(url: str, job_id: uuid.UUID) -> None:
    async with connected(url) as conn:
        await conn.execute(text("DELETE FROM iclip.generation_jobs WHERE id = :id"), {"id": job_id})


def test_an_upload_still_referenced_where_it_cannot_be_rewritten_stops_the_migration(
    migrated_pg: str,
) -> None:
    config = _alembic(migrated_pg)
    asyncio.run(_reset(migrated_pg))

    command.downgrade(config, BEFORE_UPLOADS)
    derived = asyncio.run(_plant_upload_with_a_derived_take(migrated_pg))
    try:
        with pytest.raises(RuntimeError, match="root_job_id 指着上传记录的生成记录 1 条"):
            command.upgrade(config, "head")
    finally:
        asyncio.run(_drop_job(migrated_pg, derived))
        command.upgrade(config, "head")
