"""配置页管理接口（技能库、模型供应商、agent 配置）转给运行时服务：后端验完权限与请求体，按同一个子路径转给
运行时的 ``/v1/admin/…``。

运行时那组接口与后端这三组同形（子路径、请求与答复、报错信封）。``relay`` 把答复的状态码、正文、
``content-type`` 与 ``content-disposition`` 原样交回；``relay_named`` 用在答复里带操作人 id 的端点上：
成功的答复按后端的答复模型读出，补上操作人的显示名再交回，失败的答复照样原样交回。运行时只认不透明的
操作人 id，名字只在后端补。运行时答不上（连不上、超时、5xx，或不认后端这个应用的 401、403）由客户端库抛
``RuntimeUnavailable``，组合根装的错误处理器答 503。
"""

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
"""带操作人 id 的字段；答复模型里同时有 ``<字段>_name`` 的，补上那个人的显示名。"""


class UserNames(Protocol):
    """按用户 id 一次查出显示名，由组合根接到 identity。"""

    async def __call__(self, user_ids: Collection[uuid.UUID], /) -> Mapping[uuid.UUID, str]:
        """本系统里有的那些用户的显示名；没有的 id 不在结果里。"""
        ...


# 名字字段有默认值 None 只为先按运行时的答复读出、再补名字；答复里它们总会给出，合同里也写成必有。
_NAMED_CONFIG: Final = ConfigDict(json_schema_serialization_defaults_required=True)


class AdminOut(BaseModel):
    """后端另写的答复外层（装着补了名字的模型的列表与详情）的基类，形状规则同运行时的答复模型。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
        json_schema_serialization_defaults_required=True,
    )


class CreatedByName(BaseModel):
    """混进运行时的答复模型：``createdBy`` 那个人的显示名，本系统里已没有这个人为 ``null``。"""

    model_config = _NAMED_CONFIG

    created_by_name: str | None = None


class UpdatedByName(BaseModel):
    """混进运行时的答复模型：``updatedBy`` 那个人的显示名，本系统里已没有这个人为 ``null``。"""

    model_config = _NAMED_CONFIG

    updated_by_name: str | None = None


def admin_path(*parts: str) -> str:
    """拼出 ``/v1/admin/`` 下面那一截：各部分按 ``/`` 拆段、每段整段转义；路径参数里本来就带 ``/`` 的
    （草稿文件路径、模型名）照原样分段。``.`` 与 ``..`` 段也转义成 ``%2E``，免得被 URL 规范化吃掉，
    交给运行时照进程内的规则判非法路径。"""

    return "/".join(_segment(piece) for part in parts for piece in part.split("/"))


def _segment(piece: str) -> str:
    if piece in {".", ".."}:
        return piece.replace(".", "%2E")
    return quote(piece, safe="")


async def upload_of(file: UploadFile, *, limit: int) -> AdminFiles:
    """表单里的 ``file`` 字段：最多读 ``limit + 1`` 个字节，超长与否交给运行时按同一个上限判。"""

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
    """转发一个管理请求，答复原样交回。``path`` 由 ``admin_path`` 拼出；``actor`` 是当前登录的人，放进
    ``X-End-User``（运行时只在写操作上用它记操作人）。``body`` 按别名、只带请求里给了的字段转出：有的
    更新请求按「给没给」区分不动与清空。"""

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
    """同 ``relay``，但成功的答复按 ``out``（运行时答复模型混进 ``CreatedByName`` / ``UpdatedByName``
    的后端模型）读出，整份答复里的操作人 id 合在一起查一次显示名，补上后交回；状态码照运行时的。不成功的
    答复原样交回。"""

    answer = await _send(runtime, method, path, actor=actor, body=body)
    if not 200 <= answer.status_code < 300:
        return _raw(answer)
    parsed = out.model_validate_json(answer.content)
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
    """这个模型里要补名字的操作人字段。"""

    fields = type(model).model_fields
    return (name for name in _ACTOR_FIELDS if name in fields and f"{name}_name" in fields)


def _actor_ids(value: object) -> Iterator[uuid.UUID]:
    """答复里全部要补名字的操作人 id；只往下走模型与列表，不看配置文档里的字典。"""

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
