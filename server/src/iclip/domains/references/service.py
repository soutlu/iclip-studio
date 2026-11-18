from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final

import structlog

from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.common.final_cut import TargetLocale
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as
from iclip.domains.references.models import (
    AUDIO_VOICE,
    BREAKDOWN_TIMEOUT_SECONDS,
    ERROR_TIMEOUT,
    KIND_AUDIO,
    KIND_VIDEO,
    MAX_VOICE_MS,
    MIN_VOICE_MS,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
    TEST_VIDEO_RUNNING,
    AudioKind,
    AudioScope,
    AudioText,
    NewReferenceAudio,
    Outcome,
    ReferenceAudio,
    ReferenceCursor,
    ReferenceVideo,
    Scope,
    TestVideoJob,
)
from iclip.domains.references.repository import (
    BreakdownQueue,
    MediaDuration,
    MediaSources,
    ReferenceAudioStore,
    ReferenceStore,
    TestVideos,
)
from iclip.domains.references.schemas import (
    AudioKindCountOut,
    OwnerCountOut,
    ReferenceAudioCreateIn,
    ReferenceAudioFiltersOut,
    ReferenceAudioOut,
    ReferenceAudiosOut,
    ReferenceAudioUpdateIn,
    ReferenceTagsIn,
    ReferenceVideoCreateIn,
    ReferenceVideoFiltersOut,
    ReferenceVideoItemOut,
    ReferenceVideoOut,
    ReferenceVideosOut,
    ReferenceVideoUpdateIn,
    TestVideoIn,
    TestVideoOut,
)
from iclip.domains.references.test_prompt import build_test_prompt
from iclip.domains.tagging.public import KIND_REFERENCE, EntryKey, TaggingService
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor

_logger = structlog.stdlib.get_logger(__name__)

UPLOAD_PERMISSION: Final = "uploads:write"

ENSURE_POLL_SECONDS: Final = 3.0

_BUSY: Final = frozenset({STATUS_PENDING, STATUS_RUNNING})


def _as_utc(moment: datetime | None) -> datetime | None:
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _unique[T](values: Sequence[T]) -> tuple[T, ...]:
    return tuple(dict.fromkeys(values))


def _can_edit(principal: Principal, row: ReferenceVideo) -> bool:
    return visible_owner_incl_act_as(principal) in (None, row.owner_user_id)


def _require_owner(principal: Principal, row: ReferenceVideo) -> None:
    if not _can_edit(principal, row):
        raise PermissionDenied("只有它的属主能改这条参考视频")


def _item_fields(principal: Principal, row: ReferenceVideo) -> dict[str, object]:
    return {
        "id": row.id,
        "video_url": row.video_url,
        "user_name": row.owner_user_name,
        "tag_ids": list(row.tag_ids),
        "tag_status": row.tag_status,
        "tag_error": row.tag_error,
        "breakdown_status": row.breakdown_status,
        "error_code": row.error_code,
        "version": row.version,
        "can_edit": _can_edit(principal, row),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _test_video(row: ReferenceVideo, job: TestVideoJob | None) -> TestVideoOut | None:
    if job is None:
        return None
    return TestVideoOut(
        job_id=job.job_id,
        status=job.status,
        url=job.url,
        error_message=job.error_message,
        stale=_stale(row.document, job.prompt),
        created_at=job.created_at,
    )


def _stale(document: str | None, prompt: str | None) -> bool:
    if document is None or prompt is None:
        return True
    try:
        return build_test_prompt(document).text != prompt
    except ValidationFailed:
        return True


def _item(principal: Principal, row: ReferenceVideo) -> ReferenceVideoItemOut:
    return ReferenceVideoItemOut.model_validate(_item_fields(principal, row))


def _entry_key(reference_id: uuid.UUID) -> EntryKey:
    return EntryKey(kind=KIND_REFERENCE, subject_id=reference_id)


class ReferenceService:
    def __init__(
        self,
        store: ReferenceStore,
        *,
        sources: MediaSources,
        queue: BreakdownQueue | None,
        tagging: TaggingService,
        uploads_available: bool,
        test_videos: TestVideos,
        poll_seconds: float = ENSURE_POLL_SECONDS,
        wait_seconds: float = BREAKDOWN_TIMEOUT_SECONDS,
    ) -> None:
        self._store = store
        self._sources = sources
        self._queue = queue
        self._tagging = tagging
        self._test_videos = test_videos
        self._uploads_available = uploads_available
        self._poll_seconds = poll_seconds
        self._wait_seconds = wait_seconds

    @property
    def accepts_uploads(self) -> bool:
        return self._queue is not None and self._uploads_available

    def can_upload(self, principal: Principal) -> bool:
        return self.accepts_uploads and principal.has(UPLOAD_PERMISSION)

    @property
    def can_retag(self) -> bool:
        return self._tagging.can_tag

    async def create(
        self, principal: Principal, body: ReferenceVideoCreateIn
    ) -> tuple[ReferenceVideoOut, bool]:
        if not self.accepts_uploads:
            raise RuntimeError("资料库不收上传，建行的入口不该挂上")
        queue = self._require_queue()
        if body.upload_id is not None:
            video_url = await self._sources.upload_url(principal, body.upload_id, kind=KIND_VIDEO)
            missing = "没有这条视频上传"
        elif body.source_job_id is not None:
            video_url = await self._sources.generation_url(
                principal, body.source_job_id, kind=KIND_VIDEO
            )
            missing = "没有这条已完成的素材片"
        else:
            raise RuntimeError("ReferenceVideoCreateIn 应当已核对过来源给且只给一个")
        if video_url is None:
            raise NotFound(missing)
        row, created = await self._store.ensure_row(
            video_url,
            owner=principal.user_id,
            requested_by=principal.user_id,
            api_key_id=principal.api_key_id,
            upload_id=body.upload_id,
            source_job_id=body.source_job_id,
            restore=True,
        )
        await self._tagging.ensure(_entry_key(row.id), created_by=row.owner_user_id)
        if created:
            await self._enqueue(queue, row.id)
        return await self._detail(principal, row), created

    async def list(
        self,
        principal: Principal,
        *,
        tags: Sequence[uuid.UUID] = (),
        user_name: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> ReferenceVideosOut:
        check_limit(limit)
        since, until = _as_utc(since), _as_utc(until)
        if since is not None and until is not None and since >= until:
            raise ValidationFailed("since 必须早于 until")
        keyword = q.strip() if q is not None else ""
        scope = Scope(
            tag_groups=await self._tagging.filter_groups(_unique(tags)),
            user_name=user_name,
            q=keyword or None,
            since=since,
            until=until,
        )
        after = None
        if cursor is not None:
            parsed = decode_cursor(cursor)
            after = ReferenceCursor(at=parsed.at, reference_id=parsed.uuid_key())
        rows = await self._store.list(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            next_cursor = encode_cursor(rows[-1].created_at, rows[-1].id)
        return ReferenceVideosOut(
            items=[_item(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=await self._store.count(scope) if after is None else None,
            can_upload=self.can_upload(principal),
        )

    async def filters(self) -> ReferenceVideoFiltersOut:
        owner_counts = await self._store.owner_counts()
        return ReferenceVideoFiltersOut(
            owners=[OwnerCountOut(user_name=name, count=count) for name, count in owner_counts],
        )

    async def get(self, principal: Principal, reference_id: uuid.UUID) -> ReferenceVideoOut:
        return await self._detail(principal, await self._listed(reference_id))

    async def update(
        self, principal: Principal, reference_id: uuid.UUID, body: ReferenceVideoUpdateIn
    ) -> ReferenceVideoOut:
        row = await self._listed(reference_id)
        _require_owner(principal, row)
        if row.breakdown_status in _BUSY:
            raise Conflict("这条参考视频正在拆解，拆完再改")
        written = await self._store.update(
            reference_id, version=body.version, document=body.document
        )
        if written is None:
            raise Conflict("这条参考视频已经变了（别处改过、刚拆完或正在拆），刷新后再改")
        return await self._detail(principal, await self._get(reference_id))

    async def replace_tags(
        self, principal: Principal, reference_id: uuid.UUID, body: ReferenceTagsIn
    ) -> ReferenceVideoOut:
        row = await self._listed(reference_id)
        _require_owner(principal, row)
        await self._tagging.replace(
            _entry_key(reference_id), _unique(body.tag_ids), created_by=row.owner_user_id
        )
        return await self._detail(principal, await self._get(reference_id))

    async def retag(self, principal: Principal, reference_id: uuid.UUID) -> ReferenceVideoOut:
        if not self._tagging.can_tag:
            raise RuntimeError("打标没配置，重新打标的入口不该挂上")
        row = await self._listed(reference_id)
        _require_owner(principal, row)
        if row.breakdown_status in _BUSY or row.document is None:
            raise Conflict("拆解尚未完成，无法重新打标")
        await self._tagging.retag(_entry_key(reference_id), created_by=row.owner_user_id)
        return await self._detail(principal, await self._get(reference_id))

    async def rerun(self, principal: Principal, reference_id: uuid.UUID) -> ReferenceVideoOut:
        queue = self._require_queue()
        row = await self._listed(reference_id)
        _require_owner(principal, row)
        requeued = await self._store.requeue(
            reference_id, from_failed_only=False, requested_by=principal.user_id
        )
        if not requeued:
            raise Conflict("这条参考视频正在拆解，拆完再重拆")
        await self._enqueue(queue, reference_id)
        return await self._detail(principal, await self._get(reference_id))

    async def start_test_video(
        self, principal: Principal, reference_id: uuid.UUID, body: TestVideoIn, *, user_name: str
    ) -> ReferenceVideoOut:
        row = await self._listed(reference_id)
        if not _can_edit(principal, row):
            raise PermissionDenied("只有它的属主或治理者能试生成这条参考视频")
        if row.breakdown_status in _BUSY or row.document is None:
            raise Conflict("拆解尚未完成，无法试生成")
        latest = await self._latest_test_video(row)
        if latest is not None and latest.status == TEST_VIDEO_RUNNING:
            raise Conflict("试生成进行中，无法重复提交")
        prompt = build_test_prompt(row.document)
        job_id = await self._test_videos.submit(
            principal, prompt, body.aspect_ratio, user_name=user_name
        )
        await self._store.set_test_job(reference_id, job_id)
        return await self._detail(principal, await self._get(reference_id))

    async def remove(self, principal: Principal, reference_id: uuid.UUID) -> None:
        row = await self._listed(reference_id)
        _require_owner(principal, row)
        if not await self._store.remove(reference_id):
            raise NotFound("资料库里没有这条参考视频")

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        queue = self._require_queue()
        # 对话里按地址拆解不把移除了的放回资料库，只沿用它的拆解。
        row, created = await self._store.ensure_row(
            video_url,
            owner=principal.user_id,
            requested_by=principal.user_id,
            api_key_id=principal.api_key_id,
            restore=False,
        )
        await self._tagging.ensure(_entry_key(row.id), created_by=row.owner_user_id)
        if row.document is not None:
            return Outcome(document=row.document)
        if created:
            await self._enqueue(queue, row.id)
        elif row.breakdown_status == STATUS_FAILED:
            requeued = await self._store.requeue(
                row.id, from_failed_only=True, requested_by=principal.user_id
            )
            if requeued:
                await self._enqueue(queue, row.id)
        return await self._wait(row.id)

    async def _wait(self, reference_id: uuid.UUID) -> Outcome:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._wait_seconds
        while True:
            row = await self._get(reference_id)
            if row.document is not None:
                return Outcome(document=row.document)
            if row.breakdown_status == STATUS_FAILED:
                return Outcome(document=None, error_code=row.error_code)
            if loop.time() >= deadline:
                _logger.warning("等参考视频拆解超时", reference_id=reference_id)
                return Outcome(document=None, error_code=ERROR_TIMEOUT)
            await asyncio.sleep(self._poll_seconds)

    async def _enqueue(self, queue: BreakdownQueue, reference_id: uuid.UUID) -> None:
        try:
            await queue.enqueue_breakdown(reference_id)
        except Exception:
            _logger.exception("参考视频拆解没排上队", reference_id=reference_id)
            await self._store.abandon_pending(reference_id)
            raise

    def _require_queue(self) -> BreakdownQueue:
        if self._queue is None:
            raise RuntimeError("拆解没配置，参考视频的写入口不该挂上")
        return self._queue

    async def _latest_test_video(self, row: ReferenceVideo) -> TestVideoJob | None:
        if row.test_job_id is None:
            return None
        return await self._test_videos.job(row.test_job_id)

    async def _detail(self, principal: Principal, row: ReferenceVideo) -> ReferenceVideoOut:
        job = await self._latest_test_video(row)
        return ReferenceVideoOut.model_validate(
            {
                **_item_fields(principal, row),
                "document": row.document,
                "test_video": _test_video(row, job),
            }
        )

    async def _get(self, reference_id: uuid.UUID) -> ReferenceVideo:
        row = await self._store.get(reference_id)
        if row is None:
            raise RuntimeError(f"参考视频 {reference_id} 刚才还在，现在读不到了")
        return row

    async def _listed(self, reference_id: uuid.UUID) -> ReferenceVideo:
        row = await self._store.get(reference_id)
        if row is None or row.deleted_at is not None:
            raise NotFound("资料库里没有这条参考视频")
        return row


def _audio_out(principal: Principal, row: ReferenceAudio) -> ReferenceAudioOut:
    return ReferenceAudioOut(
        id=row.id,
        url=row.url,
        title=row.title,
        description=row.description,
        duration_ms=row.duration_ms,
        audio_kind=row.audio_kind,
        locale=row.locale,
        transcript=row.transcript,
        user_name=row.owner_user_name,
        upload_id=row.upload_id,
        source_job_id=row.source_job_id,
        can_edit=visible_owner_incl_act_as(principal) in (None, row.owner_user_id),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _check_duration(audio_kind: AudioKind, duration_ms: int) -> None:
    if duration_ms <= 0:
        raise ValidationFailed("这段音频的时长不是正数，不能放进参考音频库")
    if audio_kind == AUDIO_VOICE and not MIN_VOICE_MS <= duration_ms <= MAX_VOICE_MS:
        raise ValidationFailed(
            f"音色要在 {MIN_VOICE_MS // 1000} 到 {MAX_VOICE_MS // 1000} 秒之间，"
            f"这段有 {duration_ms / 1000:g} 秒"
        )


class ReferenceAudioService:
    """参考音频库：音色、配乐、音效。不打标，不拆解。"""

    def __init__(
        self,
        store: ReferenceAudioStore,
        *,
        sources: MediaSources,
        duration: MediaDuration,
        uploads_available: bool,
    ) -> None:
        self._store = store
        self._sources = sources
        self._duration = duration
        self._uploads_available = uploads_available

    @property
    def accepts_uploads(self) -> bool:
        return self._uploads_available

    def can_upload(self, principal: Principal) -> bool:
        return self.accepts_uploads and principal.has(UPLOAD_PERMISSION)

    async def create(self, principal: Principal, body: ReferenceAudioCreateIn) -> ReferenceAudioOut:
        """入库时按地址量时长：量不出来、音色不在 3 到 30 秒之间都是 ``ValidationFailed``。"""

        if not self.accepts_uploads:
            raise RuntimeError("参考音频库不收上传，建行的入口不该挂上")
        if body.upload_id is not None:
            url = await self._sources.upload_url(principal, body.upload_id, kind=KIND_AUDIO)
            missing = "没有这条音频上传"
        elif body.source_job_id is not None:
            url = await self._sources.generation_url(principal, body.source_job_id, kind=KIND_AUDIO)
            missing = "没有这条已完成的背景音乐"
        else:
            raise RuntimeError("ReferenceAudioCreateIn 应当已核对过来源给且只给一个")
        if url is None:
            raise NotFound(missing)
        duration_ms = await self._duration(url)
        if duration_ms is None:
            raise ValidationFailed("量不出这段音频的时长，换一段能播放的音频")
        _check_duration(body.audio_kind, duration_ms)
        row = await self._store.insert(
            NewReferenceAudio(
                url=url,
                title=body.title,
                description=body.description,
                duration_ms=duration_ms,
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                upload_id=body.upload_id,
                source_job_id=body.source_job_id,
                audio_kind=body.audio_kind,
                locale=body.locale,
                transcript=body.transcript,
            )
        )
        return _audio_out(principal, row)

    async def list(
        self,
        principal: Principal,
        *,
        audio_kind: AudioKind | None = None,
        locale: TargetLocale | None = None,
        user_name: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> ReferenceAudiosOut:
        check_limit(limit)
        since, until = _as_utc(since), _as_utc(until)
        if since is not None and until is not None and since >= until:
            raise ValidationFailed("since 必须早于 until")
        keyword = q.strip() if q is not None else ""
        scope = AudioScope(
            audio_kind=audio_kind,
            locale=locale,
            user_name=user_name,
            q=keyword or None,
            since=since,
            until=until,
        )
        after = None
        if cursor is not None:
            parsed = decode_cursor(cursor)
            after = ReferenceCursor(at=parsed.at, reference_id=parsed.uuid_key())
        rows = await self._store.list(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            next_cursor = encode_cursor(rows[-1].created_at, rows[-1].id)
        return ReferenceAudiosOut(
            items=[_audio_out(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=await self._store.count(scope) if after is None else None,
            can_upload=self.can_upload(principal),
        )

    async def filters(self) -> ReferenceAudioFiltersOut:
        kind_counts = await self._store.kind_counts()
        owner_counts = await self._store.owner_counts()
        return ReferenceAudioFiltersOut(
            audio_kinds=[
                AudioKindCountOut(audio_kind=kind, count=count) for kind, count in kind_counts
            ],
            owners=[OwnerCountOut(user_name=name, count=count) for name, count in owner_counts],
        )

    async def get(self, principal: Principal, reference_id: uuid.UUID) -> ReferenceAudioOut:
        return _audio_out(principal, await self._listed(reference_id))

    async def update(
        self, principal: Principal, reference_id: uuid.UUID, body: ReferenceAudioUpdateIn
    ) -> ReferenceAudioOut:
        row = await self._listed(reference_id)
        self._require_owner(principal, row)
        given = body.model_fields_set
        text = AudioText(
            title=body.title if body.title is not None else row.title,
            description=body.description if "description" in given else row.description,
            locale=body.locale if "locale" in given else row.locale,
            transcript=body.transcript if "transcript" in given else row.transcript,
        )
        if text.transcript is not None and row.audio_kind != AUDIO_VOICE:
            raise ValidationFailed("只有音色（voice）能填台词 transcript")
        if not await self._store.update(reference_id, text):
            raise NotFound("参考音频库里没有这条音频")
        return await self.get(principal, reference_id)

    async def remove(self, principal: Principal, reference_id: uuid.UUID) -> None:
        row = await self._listed(reference_id)
        self._require_owner(principal, row)
        if not await self._store.remove(reference_id):
            raise NotFound("参考音频库里没有这条音频")

    @staticmethod
    def _require_owner(principal: Principal, row: ReferenceAudio) -> None:
        if visible_owner_incl_act_as(principal) not in (None, row.owner_user_id):
            raise PermissionDenied("只有它的属主或治理者能改这条参考音频")

    async def _listed(self, reference_id: uuid.UUID) -> ReferenceAudio:
        row = await self._store.get(reference_id)
        if row is None or row.deleted_at is not None:
            raise NotFound("参考音频库里没有这条音频")
        return row


__all__ = [
    "ENSURE_POLL_SECONDS",
    "UPLOAD_PERMISSION",
    "ReferenceAudioService",
    "ReferenceService",
]
