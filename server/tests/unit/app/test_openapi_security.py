from __future__ import annotations

from typing import Any

import pytest
from scripts.dump_openapi import PLACEHOLDER_CONFIG_DIR, PLACEHOLDER_ENV

from iclip.app.bootstrap import build_app
from iclip.config import load_runtime_config
from iclip.domains.identity.public import PERMISSIONS
from iclip.platform.media.codec import SOFTWARE

SCHEMES = {"SessionCookie", "BearerToken"}

PUBLIC = {
    ("get", "/healthz"),
    ("post", "/auth/login"),
    ("post", "/auth/register"),
    ("get", "/auth/sso/authorize"),
    ("get", "/auth/sso/callback"),
    # 成片预览：只在预览域名上开放，不看登录态，凭地址里的令牌取。
    ("get", "/whole-film/preview/{token}/host"),
    ("get", "/whole-film/preview/{token}/files/{path}"),
}

HTTP_METHODS = {"get", "put", "post", "delete", "patch", "options", "head", "trace"}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    with pytest.MonkeyPatch.context() as patch:
        for name, value in PLACEHOLDER_ENV.items():
            patch.setenv(name, value)
        patch.setattr("iclip.app.bootstrap.ffmpeg_available", lambda: True)
        app = build_app(
            load_runtime_config(PLACEHOLDER_CONFIG_DIR / "config.yaml"), media_codec=SOFTWARE
        )
        return app.openapi()


def operations(document: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (method, path): operation
        for path, item in document["paths"].items()
        for method, operation in item.items()
        if method in HTTP_METHODS
    }


def test_every_operation_outside_the_public_list_declares_security(
    document: dict[str, Any],
) -> None:
    unguarded = {
        key for key, operation in operations(document).items() if not operation.get("security")
    }

    assert unguarded == PUBLIC


def test_security_only_names_the_two_contract_schemes(document: dict[str, Any]) -> None:
    assert set(document["components"]["securitySchemes"]) == SCHEMES
    for key, operation in operations(document).items():
        for requirement in operation.get("security", []):
            assert requirement and set(requirement) <= SCHEMES, (key, requirement)


def test_scopes_are_known_permissions(document: dict[str, Any]) -> None:
    for key, operation in operations(document).items():
        for requirement in operation.get("security", []):
            for scopes in requirement.values():
                assert set(scopes) <= set(PERMISSIONS), (key, scopes)


def test_logout_is_guarded_by_the_session_cookie_alone(document: dict[str, Any]) -> None:
    assert operations(document)[("post", "/auth/logout")]["security"] == [{"SessionCookie": []}]
