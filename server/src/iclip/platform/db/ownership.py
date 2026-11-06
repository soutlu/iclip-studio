from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, Select
from sqlalchemy.orm import QueryableAttribute


def owner_conditions(
    column: ColumnElement[uuid.UUID] | QueryableAttribute[uuid.UUID],
    owner: uuid.UUID | None,
) -> list[ColumnElement[bool]]:
    if owner is None:
        return []
    return [column == owner]


def scope_to_owner[S: Select[Any]](
    stmt: S,
    column: ColumnElement[uuid.UUID] | QueryableAttribute[uuid.UUID],
    owner: uuid.UUID | None,
) -> S:
    return stmt.where(*owner_conditions(column, owner))  # type: ignore[return-value]


__all__ = ["owner_conditions", "scope_to_owner"]
