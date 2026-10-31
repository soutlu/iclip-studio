"""API key 生命周期与主体构造的业务规则（内存仓储）。"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from agent_runtime.errors import (
    AuthenticationFailed,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from iclip.domains.identity.commands import CreateApiKey
from iclip.domains.identity.models import ApiKeyRecord, UserAccount
from iclip.domains.identity.service import (
    IdentityService,
    api_key_token_prefix,
    hash_api_key_token,
    validate_api_key_token,
)
from tests.helpers.identity import (
    InMemoryApiKeyRepository,
    InMemoryUserRepository,
    make_account,
)


def make_service(
    *accounts: UserAccount,
) -> tuple[IdentityService, InMemoryUserRepository, InMemoryApiKeyRepository]:
    users = InMemoryUserRepository(list(accounts))
    api_keys = InMemoryApiKeyRepository()
    return IdentityService(users, api_keys), users, api_keys


async def test_principals_carry_the_account_username() -> None:
    """用户名跟着主体走：用户主体是自己的，key 主体是属主的；账号没有就是空，不拿邮箱顶。"""

    owner = make_account(roles=("root",), username="alice")
    nameless = make_account(username=None, email="nobody@example.com")
    service, _, _ = make_service(owner, nameless)

    assert service.principal_for_user(owner).username == "alice"
    assert service.principal_for_user(nameless).username is None

    _, token = await service.issue_api_key(
        service.principal_for_user(owner),
        CreateApiKey(name="ci", permissions=frozenset({"collections:read"})),
    )
    assert (await service.authenticate_api_key(token)).username == "alice"


async def test_direct_grant_of_issue_permission_still_caps_key_at_owner_permissions() -> None:
    owner = make_account(roles=("viewer",), direct_permissions=frozenset({"api_keys:issue"}))
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    with pytest.raises(PermissionDenied):
        await service.issue_api_key(
            principal, CreateApiKey(name="k", permissions=frozenset({"collections:write"}))
        )
    record, _ = await service.issue_api_key(
        principal, CreateApiKey(name="k", permissions=frozenset({"collections:read"}))
    )
    assert record.permissions == {"collections:read"}


async def test_issue_rejects_empty_grant() -> None:
    owner = make_account(roles=("root",))
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    with pytest.raises(ValidationFailed):
        await service.issue_api_key(principal, CreateApiKey(name="k", permissions=frozenset()))


async def test_api_key_principal_cannot_issue_keys() -> None:
    owner = make_account(roles=("root",))
    service, _, _ = make_service(owner)
    principal = service.principal_for_user(owner)
    _, token = await service.issue_api_key(
        principal, CreateApiKey(name="k", permissions=frozenset({"api_keys:issue"}))
    )
    key_principal = await service.authenticate_api_key(token)
    with pytest.raises(PermissionDenied):
        await service.issue_api_key(
            key_principal, CreateApiKey(name="k2", permissions=frozenset({"agent:read"}))
        )


async def test_revoked_expired_and_inactive_owner_all_fail_auth() -> None:
    owner = make_account(roles=("root",))
    service, users, api_keys = make_service(owner)
    principal = service.principal_for_user(owner)

    _, revoked_token = await service.issue_api_key(
        principal, CreateApiKey(name="a", permissions=frozenset({"collections:read"}))
    )
    record = (await api_keys.list_for_owner(owner.id))[0]
    await api_keys.revoke(record.id, datetime.now(UTC))
    with pytest.raises(AuthenticationFailed):
        await service.authenticate_api_key(revoked_token)

    _, expired_token = await service.issue_api_key(
        principal,
        CreateApiKey(
            name="b",
            permissions=frozenset({"collections:read"}),
            expires_at=datetime.now(UTC) + timedelta(seconds=1),
        ),
    )
    expired = next(r for r in (await api_keys.list_for_owner(owner.id)) if r.name == "b")
    api_keys.records[expired.id] = replace(
        expired, expires_at=datetime.now(UTC) - timedelta(seconds=1)
    )
    with pytest.raises(AuthenticationFailed):
        await service.authenticate_api_key(expired_token)

    _, live_token = await service.issue_api_key(
        principal, CreateApiKey(name="c", permissions=frozenset({"collections:read"}))
    )
    await users.update_access_fields(owner.id, roles=None, direct_permissions=None, is_active=False)
    with pytest.raises(AuthenticationFailed):
        await service.authenticate_api_key(live_token)


async def test_revoke_hides_others_keys_as_not_found() -> None:
    owner = make_account(roles=("root",))
    stranger = make_account(roles=("editor",), username="mallory", email="m@example.com")
    service, _, api_keys = make_service(owner, stranger)
    principal = service.principal_for_user(owner)
    await service.issue_api_key(
        principal, CreateApiKey(name="k", permissions=frozenset({"collections:read"}))
    )
    record = (await api_keys.list_for_owner(owner.id))[0]

    with pytest.raises(NotFound):
        await service.revoke_api_key(service.principal_for_user(stranger), record.id)
    with pytest.raises(NotFound):
        await service.revoke_api_key(principal, uuid.uuid4())


@pytest.mark.parametrize(
    "token",
    ["a" * 31, "has spaces in it but is long enough to pass", "a" * 31 + "!"],
)
def test_custom_token_is_rejected_when_too_short_or_not_url_safe(token: str) -> None:
    with pytest.raises(ValidationFailed):
        validate_api_key_token(token)


async def test_authenticates_a_key_issued_with_a_custom_token() -> None:
    """服务器上可按调用方已有的串签发；认证只查哈希，不看前缀。"""

    owner = make_account(roles=("root",))
    service, _, api_keys = make_service(owner)
    token = validate_api_key_token("Zq7fN2xLb9TmKd4Rv1WyPc6Hs8Gj3Ute")
    record = ApiKeyRecord(
        id=uuid.uuid4(),
        owner_user_id=owner.id,
        name="上游对接",
        token_prefix=api_key_token_prefix(token),
        permissions=frozenset({"collections:read"}),
        expires_at=None,
        revoked_at=None,
        last_used_at=None,
        created_at=None,
    )
    await api_keys.add(record, token_hash=hash_api_key_token(token))

    principal = await service.authenticate_api_key(token)
    assert principal.kind == "api_key"
    assert principal.api_key_id == record.id
    assert principal.permissions == {"collections:read"}
