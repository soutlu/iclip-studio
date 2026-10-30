"""AI 导演那一侧的适配：参考视频的结果换成导演端口的文档或失败原因。"""

from __future__ import annotations

import uuid
from typing import cast

import pytest
from agent_runtime.errors import NotFound

from iclip.app.reference_breakdown import ReferenceBreakdownsAdapter
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import Outcome
from iclip.domains.references.service import ReferenceService
from iclip.plugins.video_breakdown.ports import FailedBreakdown
from tests.helpers.identity import FakePrincipals
from tests.helpers.references import DOCUMENT, VIDEO


class FixedReferences:
    """参考视频服务的替身：``ensure`` 交回给定的结果，记下每次收到的主体。"""

    def __init__(self, outcome: Outcome) -> None:
        self._outcome = outcome
        self.principals: list[Principal] = []

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        self.principals.append(principal)
        return self._outcome


OWNER = uuid.UUID("11111111-1111-1111-1111-111111111111")
PRINCIPAL = Principal(
    kind="user",
    user_id=OWNER,
    permissions=frozenset({"agent:run"}),
    audit_label="logan",
)


def director_adapter(outcome: Outcome) -> ReferenceBreakdownsAdapter:
    return ReferenceBreakdownsAdapter(
        cast("ReferenceService", FixedReferences(outcome)), FakePrincipals(PRINCIPAL)
    )


async def test_the_director_gets_the_document_of_the_reference_video() -> None:
    adapter = director_adapter(Outcome(document=DOCUMENT))

    assert await adapter.ensure(OWNER, VIDEO) == DOCUMENT


async def test_the_director_gets_the_reason_a_breakdown_failed() -> None:
    adapter = director_adapter(Outcome(document=None, error_code="video_unreadable"))

    assert await adapter.ensure(OWNER, VIDEO) == FailedBreakdown(reason="video_unreadable")


async def test_an_outcome_with_neither_document_nor_reason_is_a_bug() -> None:
    with pytest.raises(RuntimeError, match="既没有文档也没有失败原因"):
        await director_adapter(Outcome(document=None)).ensure(OWNER, VIDEO)


async def test_the_reference_service_gets_the_principal_rebuilt_from_the_owner_id() -> None:
    principals = FakePrincipals(PRINCIPAL)
    references = FixedReferences(Outcome(document=DOCUMENT))
    adapter = ReferenceBreakdownsAdapter(cast("ReferenceService", references), principals)

    await adapter.ensure(OWNER, VIDEO)

    assert principals.asked == [OWNER]
    assert references.principals == [PRINCIPAL]


async def test_a_resolver_failure_reaches_the_caller_untouched() -> None:
    """属主账号不在了：重建主体的错误原样抛出，参考视频服务不调。"""

    references = FixedReferences(Outcome(document=DOCUMENT))
    adapter = ReferenceBreakdownsAdapter(cast("ReferenceService", references), FakePrincipals())

    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.ensure(OWNER, VIDEO)
    assert references.principals == []
