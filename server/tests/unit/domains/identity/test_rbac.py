"""角色与直接授权的合并规则，未知角色不产生权限。"""

from __future__ import annotations

from iclip.domains.identity.rbac import (
    ROLE_PERMISSIONS,
    effective_permissions,
)


def test_effective_permissions_is_role_union_plus_direct_grants() -> None:
    assert effective_permissions(("viewer",), {"generation:submit"}) == (
        ROLE_PERMISSIONS["viewer"] | {"generation:submit"}
    )
    assert effective_permissions(("viewer", "editor")) == ROLE_PERMISSIONS["editor"]


def test_unknown_role_contributes_nothing() -> None:
    assert effective_permissions(("admin",)) == frozenset()
    assert effective_permissions((), ()) == frozenset()
