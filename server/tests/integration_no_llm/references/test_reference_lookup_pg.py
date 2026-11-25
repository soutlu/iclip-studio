from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.generation_references import GenerationReferenceAssets
from iclip.domains.generation.ports import VoiceSample
from iclip.domains.identity.models import Principal
from iclip.domains.references.infra_sql import (
    SqlReferenceAudioStore,
    SqlReferenceLookup,
    SqlReferenceStore,
)
from iclip.domains.references.models import AudioKind, AudioTraits, NewReferenceAudio
from iclip.domains.uploads.infra_sql import SqlUploadRepository
from iclip.domains.uploads.models import MediaKind, MediaUpload
from iclip.domains.uploads.service import UploadService
from tests.helpers.fork_lineage import make_user
from tests.helpers.generation import FixedLineage
from tests.helpers.uploads import FakeBucket


def principal(user_id: uuid.UUID) -> Principal:
    return Principal(
        kind="user", user_id=user_id, permissions=frozenset(), audit_label=str(user_id)
    )


async def _never_fetch(url: str, *, max_bytes: int) -> bytes:
    raise AssertionError("核对参考资产不下载")


async def _writable(_principal: Principal, _conversation_id: uuid.UUID) -> None:
    return None


def assets(engine: AsyncEngine) -> GenerationReferenceAssets:
    uploads = UploadService(
        FakeBucket(),
        SqlUploadRepository(engine),
        fetch=_never_fetch,
        conversation_writable=_writable,
        lineage=FixedLineage(),
    )
    return GenerationReferenceAssets(uploads, SqlReferenceLookup(engine))


async def audio(
    engine: AsyncEngine,
    owner: uuid.UUID,
    kind: AudioKind,
    *,
    transcript: str | None = None,
    removed: bool = False,
) -> uuid.UUID:
    store = SqlReferenceAudioStore(engine)
    added = await store.insert(
        NewReferenceAudio(
            url=f"https://cdn.test/{uuid.uuid4()}.m4a",
            title=kind,
            description=None,
            duration_ms=5_000,
            owner_user_id=owner,
            api_key_id=None,
            upload_id=None,
            source_job_id=None,
            audio_kind=kind,
            locale=None,
            transcript=transcript,
            traits=AudioTraits(),
            peaks=(1.0,),
        )
    )
    if removed:
        assert await store.remove(added.id)
    return added.id


async def video(engine: AsyncEngine, owner: uuid.UUID, *, removed: bool = False) -> uuid.UUID:
    store = SqlReferenceStore(engine)
    row, _ = await store.ensure_row(
        f"https://cdn.test/{uuid.uuid4()}.mp4",
        owner=owner,
        requested_by=owner,
        api_key_id=None,
        restore=True,
    )
    if removed:
        assert await store.remove(row.id)
    return row.id


async def upload(engine: AsyncEngine, owner: uuid.UUID, kind: MediaKind) -> MediaUpload:
    return await SqlUploadRepository(engine).insert(
        MediaUpload(
            id=uuid.uuid4(),
            owner_user_id=owner,
            api_key_id=None,
            conversation_id=None,
            kind=kind,
            url=f"https://cdn.test/iclip/agent/uploads/{uuid.uuid4()}",
            content_type=None,
            size_bytes=None,
            duration_ms=None,
            width=None,
            height=None,
            content_md5=None,
            created_at=datetime.now(UTC),
        )
    )


async def test_only_a_listed_voice_is_a_voice(engine: AsyncEngine) -> None:
    owner = await make_user(engine)
    voice = await audio(engine, owner, "voice", transcript="欢迎光临")
    removed_voice = await audio(engine, owner, "voice", removed=True)
    music = await audio(engine, owner, "bgm")
    a_video = await video(engine, owner)
    lookup = assets(engine)

    stored = await SqlReferenceAudioStore(engine).get(voice)
    assert stored is not None

    assert await lookup.voice(voice) == VoiceSample(url=stored.url, transcript="欢迎光临")
    for not_a_voice in (removed_voice, music, a_video, uuid.uuid4()):
        assert await lookup.voice(not_a_voice) is None


async def test_unlisted_keeps_the_order_of_what_is_missing_or_removed(engine: AsyncEngine) -> None:
    owner = await make_user(engine)
    listed_video = await video(engine, owner)
    listed_audio = await audio(engine, owner, "sfx")
    removed_video = await video(engine, owner, removed=True)
    removed_audio = await audio(engine, owner, "voice", removed=True)
    unknown = uuid.uuid4()

    unlisted = await assets(engine).unlisted(
        [removed_audio, listed_video, unknown, listed_audio, removed_video]
    )

    assert unlisted == (removed_audio, unknown, removed_video)
    assert await assets(engine).unlisted([listed_video, listed_audio]) == ()


async def test_only_ones_own_audio_upload_counts(engine: AsyncEngine) -> None:
    me, other = await make_user(engine), await make_user(engine)
    mine = await upload(engine, me, "audio")
    theirs = await upload(engine, other, "audio")
    my_video = await upload(engine, me, "video")
    lookup = assets(engine)

    assert await lookup.own_audio_upload(principal(me), mine.id) == mine.url
    assert await lookup.own_audio_upload(principal(me), theirs.id) is None
    assert await lookup.own_audio_upload(principal(me), my_video.id) is None
