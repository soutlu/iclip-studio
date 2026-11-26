from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Protocol

from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    AudioKind,
    AudioScope,
    AudioText,
    BreakdownErrorCode,
    Claim,
    MeasuredAudio,
    NewReferenceAudio,
    ReferenceAudio,
    ReferenceCursor,
    ReferenceKind,
    ReferenceVideo,
    Scope,
    TestVideoJob,
)
from iclip.domains.references.test_prompt import TestPrompt


class ReferenceStore(Protocol):
    """参考视频：主表加视频子表，两张表在同一个事务里写。"""

    async def ensure_row(
        self,
        video_url: str,
        *,
        owner: uuid.UUID,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
        upload_id: uuid.UUID | None = None,
        source_job_id: uuid.UUID | None = None,
        restore: bool,
    ) -> tuple[ReferenceVideo, bool]:
        """按地址找这条参考视频，没有就新建（排上第一次拆解的状态），答复带着是不是新建的。

        同一个地址的新建与恢复按地址加锁排队，不会建出两条。``restore`` 时移除过的那条回到资料库，
        属主与来源换成这一次的；否则移除过的原样交回。
        """
        ...

    async def get(self, reference_id: uuid.UUID) -> ReferenceVideo | None: ...

    async def list(
        self, scope: Scope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceVideo]: ...

    async def count(self, scope: Scope) -> int: ...

    async def owner_counts(self) -> Sequence[tuple[str, int]]: ...

    async def update(
        self,
        reference_id: uuid.UUID,
        *,
        version: int,
        document: str,
    ) -> int | None: ...

    async def requeue(
        self,
        reference_id: uuid.UUID,
        *,
        from_failed_only: bool,
        requested_by: uuid.UUID,
    ) -> bool: ...

    async def abandon_pending(self, reference_id: uuid.UUID) -> None: ...

    async def claim(self, reference_id: uuid.UUID) -> Claim | None: ...

    async def finish(self, claim: Claim, *, document: str) -> bool: ...

    async def fail(self, claim: Claim, *, error_code: BreakdownErrorCode) -> bool: ...

    async def time_out_stalled(self, *, older_than_seconds: int) -> int: ...

    async def set_test_job(self, reference_id: uuid.UUID, job_id: uuid.UUID) -> None: ...

    async def remove(self, reference_id: uuid.UUID) -> bool: ...


class ReferenceAudioStore(Protocol):
    """参考音频：主表加音频子表，两张表在同一个事务里写。"""

    async def insert(self, audio: NewReferenceAudio) -> ReferenceAudio: ...

    async def get(self, reference_id: uuid.UUID) -> ReferenceAudio | None: ...

    async def list(
        self, scope: AudioScope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceAudio]: ...

    async def count(self, scope: AudioScope) -> int: ...

    async def kind_counts(self) -> Sequence[tuple[AudioKind, int]]:
        """每个子类没移除的条数，按 ``AUDIO_KINDS`` 的顺序，没有的是 0。"""
        ...

    async def owner_counts(self) -> Sequence[tuple[str, int]]: ...

    async def update(self, reference_id: uuid.UUID, text: AudioText) -> bool: ...

    async def remove(self, reference_id: uuid.UUID) -> bool: ...


class VideoBreakdowns(Protocol):
    async def breakdown(self, video_url: str, *, model_group: str | None) -> str:
        """拆一条视频，答拆解报告；``model_group`` 是调模型用哪个配置组的密钥，``None`` 即默认组。"""
        ...


class MediaSources(Protocol):
    """参考资产从哪来：一条上传，或一条生成记录。"""

    async def upload_url(
        self, principal: Principal, upload_id: uuid.UUID, *, kind: ReferenceKind
    ) -> str | None:
        """调用者本人这条 ``kind`` 上传的地址；不是本人的、种类不对或没有这条时为 None。"""
        ...

    async def generation_url(
        self, principal: Principal, job_id: uuid.UUID, *, kind: ReferenceKind
    ) -> str | None:
        """调用者看得到的一条已完成生成记录的地址：视频要是素材片，音频要是生成的背景音乐；
        看不到、种类不对或没完成时为 None。"""
        ...


class AudioMeasure(Protocol):
    async def __call__(self, url: str, /) -> MeasuredAudio | None:
        """这个地址上音频的时长与波形峰值，同一次解码量出；量不出来为 None。"""
        ...


class BreakdownQueue(Protocol):
    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None: ...


class TestVideos(Protocol):
    async def job(self, job_id: uuid.UUID) -> TestVideoJob | None: ...

    async def submit(
        self,
        principal: Principal,
        prompt: TestPrompt,
        aspect_ratio: str,
        *,
        user_name: str,
    ) -> uuid.UUID:
        """提交一次试生成，答这条试生成记录的 id。"""
        ...


__all__ = [
    "AudioMeasure",
    "BreakdownQueue",
    "MediaSources",
    "ReferenceAudioStore",
    "ReferenceStore",
    "TestVideos",
    "VideoBreakdowns",
]
