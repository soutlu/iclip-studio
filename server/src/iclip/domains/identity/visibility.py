from __future__ import annotations

import uuid

from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION, MANAGE_PERMISSION


def visible_owner(principal: Principal) -> uuid.UUID | None:
    return None if principal.has(MANAGE_PERMISSION) else principal.user_id


def visible_owner_incl_act_as(principal: Principal) -> uuid.UUID | None:
    if principal.kind == "api_key" and principal.has(ACT_AS_PERMISSION):
        return None
    return visible_owner(principal)


__all__ = ["visible_owner", "visible_owner_incl_act_as"]
