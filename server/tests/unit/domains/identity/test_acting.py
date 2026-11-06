from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
import structlog

from iclip.domains.identity.acting import (
    ActAs,
    is_placeholder_account,
    placeholder_email,
)
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from iclip.domains.identity.sso import sso_placeholder_email
from tests.helpers.identity import InMemoryUserRepository


def browser(username: str | None = "logan") -> Principal:
    return Principal(
        kind="user",
        user_id=uuid.uuid4(),
        permissions=frozenset({"agent:run"}),
        audit_label="logan",
        username=username,
    )


def api_key(*permissions: str) -> Principal:
    return Principal(
        kind="api_key",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="logan#partner-app",
        api_key_id=uuid.uuid4(),
        username="logan",
        key_name="partner-app",
    )


async def test_key_with_the_permission_acts_as_the_named_person() -> None:
    users = InMemoryUserRepository()
    key = api_key("agent:run", ACT_AS_PERMISSION)

    acting = await act_as_with(users)(key, "Sara.Hong")

    (placeholder,) = users.accounts.values()
    assert placeholder.username == "Sara.Hong"
    assert is_placeholder_account("Sara.Hong", placeholder.email)
    assert acting.user_id == placeholder.id
    assert acting.username == "Sara.Hong"
    assert acting.audit_label == "Sara.Hong#partner-app"
    assert acting.permissions == key.permissions
    assert acting.api_key_id == key.api_key_id
    assert acting.kind == "api_key"


@pytest.fixture
def log_context() -> Iterator[None]:
    structlog.contextvars.clear_contextvars()
    try:
        yield
    finally:
        structlog.contextvars.clear_contextvars()


async def test_switching_marks_the_log_context_with_who_is_acted_as(log_context: None) -> None:
    structlog.contextvars.bind_contextvars(principal="logan#partner-app")

    await act_as_with(InMemoryUserRepository())(api_key(ACT_AS_PERMISSION), "Sara.Hong")

    assert structlog.contextvars.get_contextvars() == {
        "principal": "logan#partner-app",
        "acting_as": "Sara.Hong",
    }


async def test_no_switch_leaves_the_log_context_alone(log_context: None) -> None:
    users = InMemoryUserRepository()

    await act_as_with(users)(browser(), "logan")
    await act_as_with(users)(api_key("agent:run"), "Sara.Hong")
    await act_as_with(users)(api_key(ACT_AS_PERMISSION), None)

    assert structlog.contextvars.get_contextvars() == {}


async def test_blank_name_means_nobody_to_act_as() -> None:
    users = InMemoryUserRepository()
    key = api_key(ACT_AS_PERMISSION)
    for blank in (None, "", "   "):
        assert await act_as_with(users)(key, blank) is key
    assert users.accounts == {}


def test_placeholder_account_is_recognized_only_by_its_own_name() -> None:
    assert is_placeholder_account("Sara.Hong", placeholder_email("Sara.Hong"))
    assert not is_placeholder_account("Sara.Hong", "sara.hong@example.com")
    assert not is_placeholder_account("Sara.Hong", sso_placeholder_email("u-7"))
    assert not is_placeholder_account("sara.hong", placeholder_email("Sara.Hong"))
    assert not is_placeholder_account("Rudy", placeholder_email("Sara.Hong"))


def act_as_with(users: InMemoryUserRepository) -> ActAs:
    return ActAs(users)
