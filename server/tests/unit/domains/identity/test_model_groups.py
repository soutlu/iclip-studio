from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import ModelGroupUnavailable, NotFound
from iclip.domains.identity.public import ModelGroupAssignments
from tests.helpers.identity import InMemoryUserRepository, make_account

CONFIGURED = ("mkt", "ecom")


@pytest.mark.parametrize("stored", ["ecom", None], ids=["chosen_group", "default_group"])
async def test_a_user_is_in_the_group_stored_on_them(stored: str | None) -> None:
    account = make_account(model_group=stored)
    groups = ModelGroupAssignments(InMemoryUserRepository([account]), CONFIGURED)

    assert await groups.group_of(account.id) == stored


@pytest.mark.parametrize(
    "configured", [CONFIGURED, ()], ids=["group_removed", "no_groups_configured"]
)
async def test_a_stored_group_gone_from_the_config_is_refused_not_defaulted(
    configured: tuple[str, ...],
) -> None:
    account = make_account(model_group="retired")
    groups = ModelGroupAssignments(InMemoryUserRepository([account]), configured)

    with pytest.raises(ModelGroupUnavailable, match="retired"):
        await groups.group_of(account.id)


async def test_an_unknown_user_is_not_silently_put_in_the_default_group() -> None:
    groups = ModelGroupAssignments(InMemoryUserRepository(), CONFIGURED)

    with pytest.raises(NotFound):
        await groups.group_of(uuid.uuid4())
