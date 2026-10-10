"""参考视频的端口：自有表的仓储，以及由组合根接上的拆解、打标、上传记录与试生成。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Protocol

from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    BreakdownErrorCode,
    CategoryValue,
    Claim,
    ReferenceCursor,
    ReferenceVideo,
    Scope,
    Tags,
    TestVideoJob,
    VideoTypeValue,
)
from iclip.domains.references.test_prompt import TestPrompt


class ReferenceStore(Protocol):
    """``reference_videos`` 的数据访问。状态跳转都是带条件的更新，不读后整体覆盖。"""

    async def ensure_row(
        self,
        video_url: str,
        *,
        owner: uuid.UUID,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> tuple[ReferenceVideo, bool]:
        """这条视频的那一行；没有就以 ``pending`` 新建。第二项是这次是不是新建的：并发的几次里只有
        一次为真。已有的行不改，属主仍是第一次建它的人。"""
        ...

    async def get(self, reference_id: uuid.UUID) -> ReferenceVideo | None:
        """按 id 读，含已移除的；没有给 ``None``。"""
        ...

    async def list(
        self, scope: Scope, *, limit: int, after: ReferenceCursor | None
    ) -> Sequence[ReferenceVideo]:
        """没移除的行，建立晚的排前面，同一刻按 id 倒序。"""
        ...

    async def count(self, scope: Scope) -> int:
        """筛选范围里没移除的行数。"""
        ...

    async def filter_counts(
        self,
    ) -> tuple[Mapping[VideoTypeValue, int], Sequence[tuple[CategoryValue, int]]]:
        """没移除的行里每种片子类型、每个用到的品类各有几条；品类按条数多的在前。"""
        ...

    async def owner_counts(self) -> Sequence[tuple[str, int]]:
        """没移除的行按属主的用户名各有几条；条数多的在前，同数按用户名。"""
        ...

    async def update(
        self,
        reference_id: uuid.UUID,
        *,
        version: int,
        document: str,
        tags: Tags,
    ) -> int | None:
        """改拆解正文与两组标签，版本加一，交回新版本。没移除、版本对得上、不在拆解中才改；
        否则给 ``None``。"""
        ...

    async def requeue(
        self,
        reference_id: uuid.UUID,
        *,
        from_failed_only: bool,
        requested_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> bool:
        """已完成或已失败的行改回 ``pending`` 等后台接手，记下这次是谁要的；``from_failed_only`` 只动
        已失败的。行不在这几种状态（正在排队或拆解）就不动，给 ``False``。"""
        ...

    async def abandon_pending(self, reference_id: uuid.UUID) -> None:
        """排队没排上：还在 ``pending`` 的这一行改成 ``failed / model_call_failed``，拆解与标签不动。"""
        ...

    async def claim(self, reference_id: uuid.UUID) -> Claim | None:
        """``pending`` 改成 ``running`` 并记开始时刻；不在 ``pending`` 给 ``None``。"""
        ...

    async def finish(self, claim: Claim, *, document: str, tags: Tags) -> bool:
        """这一次拆完：覆盖拆解与标签、清掉失败原因、版本加一。这一次已被收尾（不在拆解中，或开始
        时刻对不上）给 ``False``，不写。"""
        ...

    async def fail(self, claim: Claim, *, error_code: BreakdownErrorCode) -> bool:
        """这一次没拆成：记失败原因，拆解与标签不动。已被收尾给 ``False``，不写。"""
        ...

    async def time_out_stalled(self, *, older_than_seconds: int) -> int:
        """开始超过这么久还在拆解中的行改成 ``failed / timeout``，交回改了几行。"""
        ...

    async def restore(self, reference_id: uuid.UUID, *, owner: uuid.UUID) -> None:
        """清掉移除时刻，让这一行回到资料库，属主换成 ``owner``；没移除的不动。"""
        ...

    async def remove(self, reference_id: uuid.UUID) -> bool:
        """记移除时刻；已移除或不存在给 ``False``。"""
        ...


class VideoBreakdowns(Protocol):
    """把一条视频拆成一份 Markdown 文档；每次调用都是一次付费模型调用。"""

    async def breakdown(self, video_url: str) -> str:
        """拆不成抛 ``BreakdownFailed``，带上落到行上的失败原因。"""
        ...


class Tagger(Protocol):
    """按拆解全文给视频打两组标签；每次调用都是一次付费模型调用。"""

    async def tag(self, document: str) -> Tags:
        """给不出可用的标签抛 ``TaggingFailed``；交回的两组已去重，只含清单里的值。"""
        ...


OwnVideoUpload = Callable[[Principal, uuid.UUID], Awaitable[str | None]]
"""主体本人这条视频上传的地址，参数为（主体，``uploadId``）；不是他的、不是视频上传或不存在都给
``None``。由组合根接到生成域的上传记录上。"""


class BreakdownQueue(Protocol):
    """把一行交给后台拆解。"""

    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None:
        """排一次拆解；排不上就抛出。"""
        ...


class TestVideos(Protocol):
    """参考视频的试生成：记成生成域的一条视频生成，由组合根接上。"""

    async def latest(self, owner: uuid.UUID, reference_id: uuid.UUID) -> TestVideoJob | None:
        """``owner`` 名下这条参考视频最新的一次试生成；没有给 ``None``。"""
        ...

    async def submit(
        self,
        principal: Principal,
        reference_id: uuid.UUID,
        prompt: TestPrompt,
        aspect_ratio: str,
        *,
        user_name: str,
    ) -> None:
        """以主体的名义提交一次试生成，``user_name`` 照原样作发往上游的归属标签，排上队就返回。
        正文超长或请求不合法抛 ``ValidationFailed``。"""
        ...


__all__ = [
    "BreakdownQueue",
    "OwnVideoUpload",
    "ReferenceStore",
    "Tagger",
    "TestVideos",
    "VideoBreakdowns",
]
