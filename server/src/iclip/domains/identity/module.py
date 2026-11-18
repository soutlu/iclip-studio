from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.identity.accounts import (
    CookieAuthSettings,
    build_jwt_strategy,
    make_user_manager_context,
)
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.api import (
    create_account_routers,
    create_api_keys_router,
    create_sso_router,
    create_users_router,
)
from iclip.domains.identity.infra_sql import (
    SessionFactory,
    SqlApiKeyRepository,
    SqlUserRepository,
    account_from_row,
)
from iclip.domains.identity.middleware import PrincipalResolver, session_cookie_name
from iclip.domains.identity.models import UserAccount
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.service import IdentityService
from iclip.domains.identity.sso import SsoVerifier


@dataclass(frozen=True, slots=True)
class SsoRuntime:
    base_url: str
    app_name: str
    redirect_url: str
    pms_base_url: str | None
    oauth_name: str
    root_email: str | None = None


@dataclass(frozen=True)
class IdentityModule:
    routers: tuple[Any, ...]
    resolver: PrincipalResolver
    service: IdentityService
    users: SqlUserRepository
    api_keys: SqlApiKeyRepository
    act_as: ActAs


def build_identity_module(
    sessions: SessionFactory,
    auth: CookieAuthSettings,
    sso: SsoRuntime | None,
    *,
    sso_verifier: SsoVerifier | None = None,
    pms_client: PmsUserClient | None = None,
) -> IdentityModule:
    users = SqlUserRepository(sessions)
    api_keys = SqlApiKeyRepository(sessions)
    service = IdentityService(users, api_keys)
    user_manager_ctx = make_user_manager_context(sessions, secret=auth.secret)
    session_strategy = build_jwt_strategy(auth)

    async def read_session_user(token: str) -> UserAccount | None:
        async with user_manager_ctx() as manager:
            user = await session_strategy.read_token(token, manager)
            if user is None or not user.is_active:
                return None
            return account_from_row(user)

    resolver = PrincipalResolver(
        read_session_user=read_session_user,
        service=service,
        session_cookie_name=session_cookie_name(secure=auth.cookie_secure),
    )

    routers: list[Any] = [
        *create_account_routers(sessions, auth),
        create_users_router(service),
        create_api_keys_router(service),
    ]
    if sso is not None:
        verifier = sso_verifier or SsoVerifier(
            base_url=sso.base_url,
            app_name=sso.app_name,
            redirect_url=sso.redirect_url,
        )
        pms = pms_client
        if pms is None and sso.pms_base_url:
            pms = PmsUserClient(base_url=sso.pms_base_url)
        routers.append(
            create_sso_router(
                sessions,
                auth,
                verifier,
                pms,
                users,
                sso.root_email,
                oauth_name=sso.oauth_name,
            )
        )

    return IdentityModule(
        routers=tuple(routers),
        resolver=resolver,
        service=service,
        users=users,
        api_keys=api_keys,
        act_as=ActAs(users),
    )


__all__ = ["IdentityModule", "SsoRuntime", "build_identity_module"]
