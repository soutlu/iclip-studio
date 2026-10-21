"""AI 导演那一侧的适配：参考视频的结果换成导演端口的文档或失败原因。"""

from __future__ import annotations

from typing import cast

import pytest

from iclip.app.reference_breakdown import ReferenceBreakdownsAdapter
from iclip.capabilities.video_breakdown.ports import FailedBreakdown
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import Outcome
from iclip.domains.references.service import ReferenceService
from tests.helpers.references import DOCUMENT, VIDEO


class FixedReferences:
    """参考视频服务的替身：``ensure`` 交回给定的结果。"""

    def __init__(self, outcome: Outcome) -> None:
        self._outcome = outcome

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        return self._outcome


def director_adapter(outcome: Outcome) -> ReferenceBreakdownsAdapter:
    return ReferenceBreakdownsAdapter(cast("ReferenceService", FixedReferences(outcome)))


PRINCIPAL = cast("Principal", object())


async def test_the_director_gets_the_document_of_the_reference_video() -> None:
    adapter = director_adapter(Outcome(document=DOCUMENT))

    assert await adapter.ensure(PRINCIPAL, VIDEO) == DOCUMENT


async def test_the_director_gets_the_reason_a_breakdown_failed() -> None:
    adapter = director_adapter(Outcome(document=None, error_code="video_unreadable"))

    assert await adapter.ensure(PRINCIPAL, VIDEO) == FailedBreakdown(reason="video_unreadable")


async def test_an_outcome_with_neither_document_nor_reason_is_a_bug() -> None:
    with pytest.raises(RuntimeError, match="既没有文档也没有失败原因"):
        await director_adapter(Outcome(document=None)).ensure(PRINCIPAL, VIDEO)
