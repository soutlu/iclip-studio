from __future__ import annotations

import uuid
from collections.abc import Collection, Iterator, Mapping, Sequence
from typing import Final, Protocol, cast
from urllib.parse import quote

from agent_runtime.client import AdminFiles, AdminResponse, RuntimeClient
from fastapi import Response, UploadFile
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

AdminParams = Mapping[str, str | Sequence[str]]

_ACTOR_FIELDS: Final = ("created_by", "updated_by")


class UserNames(Protocol):
    async def __call__(self, user_ids: Collection[uuid.UUID], /) -> Mapping[uuid.UUID, str]: ...


_NAMED_CONFIG: Final = ConfigDict(json_schema_serialization_defaults_required=True)


class AdminOut(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
        json_schema_serialization_defaults_required=True,
    )


class CreatedByName(BaseModel):
    model_config = _NAMED_CONFIG

    created_by_name: str | None = None


class UpdatedByName(BaseModel):
    model_config = _NAMED_CONFIG

    updated_by_name: str | None = None


def admin_path(*parts: str) -> str:
    return "/".join(_segment(piece) for part in parts for piece in part.split("/"))


def _segment(piece: str) -> str:
    if piece in {".", ".."}:
        return piece.replace(".", "%2E")
    return quote(piece, safe="")


async def upload_of(file: UploadFile, *, limit: int) -> AdminFiles:
    data = await file.read(limit + 1)
    return {
        "file": (
            file.filename or "upload",
            data,
            file.content_type or "application/octet-stream",
        )
    }


async def relay(
    runtime: RuntimeClient,
    method: str,
    path: str,
    *,
    actor: uuid.UUID,
    params: AdminParams | None = None,
    body: BaseModel | None = None,
    files: AdminFiles | None = None,
) -> Response:
    answer = await _send(runtime, method, path, actor=actor, params=params, body=body, files=files)
    return _raw(answer)


async def relay_named(
    runtime: RuntimeClient,
    user_names: UserNames,
    out: type[BaseModel],
    method: str,
    path: str,
    *,
    actor: uuid.UUID,
    body: BaseModel | None = None,
) -> Response:
    answer = await _send(runtime, method, path, actor=actor, body=body)
    if not 200 <= answer.status_code < 300:
        return _raw(answer)
    parsed = out.model_validate_json(answer.content, extra="ignore")
    ids = set(_actor_ids(parsed))
    names = await user_names(ids) if ids else {}
    return Response(
        content=_with_names(parsed, names).model_dump_json(by_alias=True),
        status_code=answer.status_code,
        media_type="application/json",
    )


async def _send(
    runtime: RuntimeClient,
    method: str,
    path: str,
    *,
    actor: uuid.UUID,
    params: AdminParams | None = None,
    body: BaseModel | None = None,
    files: AdminFiles | None = None,
) -> AdminResponse:
    return await runtime.admin_request(
        method,
        path,
        end_user=actor,
        params=params,
        json=None
        if body is None
        else body.model_dump(mode="json", by_alias=True, exclude_unset=True),
        files=files,
    )


def _raw(answer: AdminResponse) -> Response:
    headers: dict[str, str] = {}
    if answer.content_type is not None:
        headers["content-type"] = answer.content_type
    if answer.content_disposition is not None:
        headers["content-disposition"] = answer.content_disposition
    return Response(content=answer.content, status_code=answer.status_code, headers=headers)


def _named_fields(model: BaseModel) -> Iterator[str]:
    fields = type(model).model_fields
    return (name for name in _ACTOR_FIELDS if name in fields and f"{name}_name" in fields)


def _actor_ids(value: object) -> Iterator[uuid.UUID]:
    if isinstance(value, BaseModel):
        for name in _named_fields(value):
            yield getattr(value, name)
        for name in type(value).model_fields:
            yield from _actor_ids(getattr(value, name))
    elif isinstance(value, list):
        for item in cast("list[object]", value):
            yield from _actor_ids(item)


def _with_names[Out: BaseModel](value: Out, names: Mapping[uuid.UUID, str]) -> Out:
    update: dict[str, object] = {
        f"{name}_name": names.get(getattr(value, name)) for name in _named_fields(value)
    }
    for name in type(value).model_fields:
        child: object = getattr(value, name)
        if isinstance(child, BaseModel):
            update[name] = _with_names(child, names)
        elif isinstance(child, list):
            items = cast("list[object]", child)
            if any(isinstance(item, BaseModel) for item in items):
                update[name] = [
                    _with_names(item, names) if isinstance(item, BaseModel) else item
                    for item in items
                ]
    return value.model_copy(update=update)


__all__ = [
    "AdminOut",
    "AdminParams",
    "CreatedByName",
    "UpdatedByName",
    "UserNames",
    "admin_path",
    "relay",
    "relay_named",
    "upload_of",
]
