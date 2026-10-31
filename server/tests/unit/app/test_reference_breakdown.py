"""拆解适配拒绝既没有文档也没有失败原因的非法结果。"""

from __future__ import annotations

import uuid
from typing import cast

import pytest

from iclip.app.reference_breakdown import ReferenceBreakdownsAdapter
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import Outcome
from iclip.domains.references.service import ReferenceService
from tests.helpers.identity import FakePrincipals
from tests.helpers.references import VIDEO


class EmptyReferences:
    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        return Outcome(document=None)


async def test_an_outcome_with_neither_document_nor_reason_is_a_bug() -> None:
    principal = Principal(
        kind="user",
        user_id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
        permissions=frozenset({"agent:run"}),
        audit_label="logan",
    )
    adapter = ReferenceBreakdownsAdapter(
        cast("ReferenceService", EmptyReferences()), FakePrincipals(principal)
    )

    with pytest.raises(RuntimeError, match="既没有文档也没有失败原因"):
        await adapter.ensure(principal.user_id, VIDEO)
