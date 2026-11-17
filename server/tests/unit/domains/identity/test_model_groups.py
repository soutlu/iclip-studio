from __future__ import annotations

import uuid

import pytest

from iclip.common.errors import NotFound
from iclip.domains.identity.public import DepartmentGroup, ModelGroupResolver
from tests.helpers.identity import InMemoryUserRepository, department, make_account

GROUPS = (
    DepartmentGroup(name="mkt", departments=frozenset({101, 102})),
    DepartmentGroup(name="ecom", departments=frozenset({201})),
)


async def group_of(
    *department_ids: int, groups: tuple[DepartmentGroup, ...] = GROUPS
) -> str | None:
    account = make_account(departments=tuple(department(d) for d in department_ids))
    resolver = ModelGroupResolver(InMemoryUserRepository([account]), groups)
    return await resolver.group_of(account.id)


@pytest.mark.parametrize(
    ("departments", "expected"),
    [
        ((102,), "mkt"),
        ((201,), "ecom"),
        ((999,), None),
        ((), None),
    ],
    ids=["mkt", "ecom", "unknown_department", "no_department"],
)
async def test_a_user_falls_in_the_group_listing_one_of_their_departments(
    departments: tuple[int, ...], expected: str | None
) -> None:
    assert await group_of(*departments) == expected


async def test_a_user_in_two_groups_takes_the_one_listed_first() -> None:
    assert await group_of(201, 101) == "mkt"
    assert await group_of(201, 101, groups=GROUPS[::-1]) == "ecom"


async def test_only_the_users_own_departments_count_not_their_parents() -> None:
    account = make_account(departments=(department(301, parent_id=101),))
    resolver = ModelGroupResolver(InMemoryUserRepository([account]), GROUPS)

    assert await resolver.group_of(account.id) is None


async def test_an_unknown_user_is_not_silently_put_in_the_default_group() -> None:
    resolver = ModelGroupResolver(InMemoryUserRepository(), GROUPS)

    with pytest.raises(NotFound):
        await resolver.group_of(uuid.uuid4())
