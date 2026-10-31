"""配置页管理接口（技能库、模型供应商、agent 配置）转给运行时服务：后端验完权限与请求体，按同一个子路径转给
运行时的 ``/v1/admin/…``，答复的状态码、正文、``content-type`` 与 ``content-disposition`` 原样交回。

运行时那组接口与后端这三组同形（子路径、请求与答复、报错信封），所以转发不改写任何内容；运行时答不上
（连不上、超时、5xx，或不认后端这个应用的 401、403）由客户端库抛 ``RuntimeUnavailable``，组合根装的错误
处理器答 503。
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from urllib.parse import quote

from agent_runtime.client import AdminFiles, RuntimeClient
from fastapi import Response, UploadFile
from pydantic import BaseModel

AdminParams = Mapping[str, str | Sequence[str]]


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
    """转发一个管理请求。``path`` 由 ``admin_path`` 拼出；``actor`` 是当前登录的人，放进 ``X-End-User``
    （运行时只在写操作上用它记操作人）。``body`` 按别名、只带请求里给了的字段转出：有的更新请求按「给没
    给」区分不动与清空。"""

    answer = await runtime.admin_request(
        method,
        path,
        end_user=actor,
        params=params,
        json=None
        if body is None
        else body.model_dump(mode="json", by_alias=True, exclude_unset=True),
        files=files,
    )
    headers: dict[str, str] = {}
    if answer.content_type is not None:
        headers["content-type"] = answer.content_type
    if answer.content_disposition is not None:
        headers["content-disposition"] = answer.content_disposition
    return Response(content=answer.content, status_code=answer.status_code, headers=headers)


__all__ = ["AdminParams", "admin_path", "relay", "upload_of"]
