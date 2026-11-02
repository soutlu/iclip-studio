"""MCP 服务的一张表与它的 Postgres 仓储。

时间统一用数据库时钟。连接方式与请求头、工具的形状只在 Python 里检查，表上不加 CHECK；``url`` 是密文，
``url_hash`` 是明文地址的 sha256，地址与名称各有唯一约束；请求头是 jsonb ``[{name, value}]``，值是密文。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import asynccontextmanager
from typing import Any, Final, cast

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    MetaData,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    delete,
    func,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from agent_runtime.config.mcp_servers.models import (
    McpCheck,
    McpHeader,
    McpServerRecord,
    McpTool,
    McpTransport,
)
from agent_runtime.errors import Conflict, NotFound

DB_SCHEMA: Final = "agent_runtime"

metadata_obj = MetaData(schema=DB_SCHEMA)

_DUPLICATE_ID: Final = "mcp_servers_pkey"
_DUPLICATE_URL: Final = "uq_mcp_servers_url_hash"
_DUPLICATE_NAME: Final = "uq_mcp_servers_name"

mcp_servers_table = Table(
    "mcp_servers",
    metadata_obj,
    Column("id", Text, primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False),
    Column("url", Text, nullable=False),
    Column("url_hash", Text, nullable=False),
    Column("transport", Text, nullable=False),
    Column("timeout_seconds", Integer, nullable=False),
    Column("headers", JSONB, nullable=False),
    Column("enabled", Boolean, nullable=False),
    Column("check_ok", Boolean, nullable=True),
    Column("check_elapsed_ms", Integer, nullable=True),
    Column("check_reason", Text, nullable=True),
    Column("checked_at", DateTime(timezone=True), nullable=True),
    Column("tools", JSONB, nullable=True),
    Column("created_by", Uuid, nullable=False),
    Column("updated_by", Uuid, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("url_hash", name=_DUPLICATE_URL),
    UniqueConstraint("name", name=_DUPLICATE_NAME),
)

_c = mcp_servers_table.c


def _violated_constraint(error: IntegrityError) -> str:
    """违反的约束名；asyncpg 把它挂在被包起来的原异常上。"""

    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None) or ""


async def _duplicate(
    engine: AsyncEngine, error: IntegrityError, *, url_hash: str, name: str
) -> Conflict | None:
    """地址或名称撞了已有服务时给人看的 ``Conflict``，写明撞的是哪个服务；别的约束交回 ``None``。

    要在出错的事务回滚之后调：另开一个连接按哈希查那个服务的名称。查的时候它已被删掉，就只说地址登记过。"""

    violated = _violated_constraint(error)
    if violated == _DUPLICATE_NAME:
        return Conflict(f"这个名称已经有了：{name}")
    if violated != _DUPLICATE_URL:
        return None
    async with engine.connect() as conn:
        existing = (
            await conn.execute(select(_c.name).where(_c.url_hash == url_hash))
        ).scalar_one_or_none()
    return Conflict("这个地址已经登记过" if existing is None else f"这个地址已经登记过：{existing}")


def _headers_json(headers: Sequence[McpHeader]) -> list[dict[str, str]]:
    return [{"name": one.name, "value": one.value} for one in headers]


def _tools_json(tools: Sequence[McpTool]) -> list[dict[str, str | None]]:
    return [{"name": one.name, "description": one.description} for one in tools]


def _record(row: RowMapping) -> McpServerRecord:
    headers = cast(list[dict[str, str]], row["headers"])
    tools = cast(list[dict[str, Any]] | None, row["tools"])
    checked_at = row["checked_at"]
    return McpServerRecord(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        url=row["url"],
        url_hash=row["url_hash"],
        transport=cast(McpTransport, row["transport"]),
        timeout_seconds=row["timeout_seconds"],
        headers=tuple(McpHeader(name=one["name"], value=one["value"]) for one in headers),
        enabled=row["enabled"],
        check=None
        if checked_at is None
        else McpCheck(
            ok=row["check_ok"],
            elapsed_ms=row["check_elapsed_ms"],
            reason=row["check_reason"],
            checked_at=checked_at,
        ),
        tools=None
        if tools is None
        else tuple(McpTool(name=one["name"], description=one["description"]) for one in tools),
        created_by=row["created_by"],
        updated_by=row["updated_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


_CLEARED_CHECK: Final = {
    "check_ok": None,
    "check_elapsed_ms": None,
    "check_reason": None,
    "checked_at": None,
    "tools": None,
}


class _SqlMcpServerEditor:
    def __init__(self, conn: AsyncConnection, record: McpServerRecord) -> None:
        self._conn = conn
        self._record = record
        # ``update`` 写下的地址哈希与名称，事务回滚后据此说明撞了哪个服务。
        self.written: tuple[str, str] | None = None

    @property
    def record(self) -> McpServerRecord:
        return self._record

    async def update(
        self,
        *,
        name: str,
        description: str,
        url: str,
        url_hash: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        clear_check: bool,
        by: uuid.UUID,
    ) -> None:
        self.written = (url_hash, name)
        await self._conn.execute(
            update(mcp_servers_table)
            .where(_c.id == self._record.id)
            .values(
                name=name,
                description=description,
                url=url,
                url_hash=url_hash,
                transport=transport,
                timeout_seconds=timeout_seconds,
                headers=_headers_json(headers),
                enabled=enabled,
                updated_by=by,
                updated_at=func.now(),
                **(_CLEARED_CHECK if clear_check else {}),
            )
        )

    async def delete(self) -> None:
        await self._conn.execute(delete(mcp_servers_table).where(_c.id == self._record.id))


class SqlMcpServerStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def list(self) -> tuple[McpServerRecord, ...]:
        async with self._engine.connect() as conn:
            rows = await conn.execute(
                select(mcp_servers_table).order_by(_c.created_at.desc(), _c.id.desc())
            )
            return tuple(_record(row) for row in rows.mappings())

    async def get(self, server_id: str) -> McpServerRecord | None:
        async with self._engine.connect() as conn:
            row = (
                (await conn.execute(select(mcp_servers_table).where(_c.id == server_id)))
                .mappings()
                .first()
            )
            return None if row is None else _record(row)

    async def insert(
        self,
        server_id: str,
        *,
        name: str,
        description: str,
        url: str,
        url_hash: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        by: uuid.UUID,
    ) -> None:
        try:
            async with self._engine.begin() as conn:
                await conn.execute(
                    mcp_servers_table.insert().values(
                        id=server_id,
                        name=name,
                        description=description,
                        url=url,
                        url_hash=url_hash,
                        transport=transport,
                        timeout_seconds=timeout_seconds,
                        headers=_headers_json(headers),
                        enabled=enabled,
                        created_by=by,
                        updated_by=by,
                    )
                )
        except IntegrityError as exc:
            if _violated_constraint(exc) == _DUPLICATE_ID:
                raise Conflict(f"已有标识为「{server_id}」的 MCP 服务") from exc
            conflict = await _duplicate(self._engine, exc, url_hash=url_hash, name=name)
            if conflict is None:
                raise
            raise conflict from exc

    @asynccontextmanager
    async def edit(self, server_id: str) -> AsyncGenerator[_SqlMcpServerEditor]:
        editor: _SqlMcpServerEditor | None = None
        try:
            async with self._engine.begin() as conn:
                row = (
                    (
                        await conn.execute(
                            select(mcp_servers_table).where(_c.id == server_id).with_for_update()
                        )
                    )
                    .mappings()
                    .first()
                )
                if row is None:
                    raise NotFound("MCP 服务不存在")
                editor = _SqlMcpServerEditor(conn, _record(row))
                yield editor
        except IntegrityError as exc:
            # 事务已回滚，另开连接查撞了哪个服务。
            if editor is None or editor.written is None:
                raise
            url_hash, name = editor.written
            conflict = await _duplicate(self._engine, exc, url_hash=url_hash, name=name)
            if conflict is None:
                raise
            raise conflict from exc

    async def record_check(
        self,
        server_id: str,
        *,
        ok: bool,
        elapsed_ms: int,
        reason: str | None,
        tools: Sequence[McpTool] | None,
    ) -> bool:
        values: dict[str, Any] = {
            "check_ok": ok,
            "check_elapsed_ms": elapsed_ms,
            "check_reason": reason,
            "checked_at": func.now(),
        }
        if tools is not None:
            values["tools"] = _tools_json(tools)
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(mcp_servers_table).where(_c.id == server_id).values(**values)
            )
            return result.rowcount > 0

    async def rewrite_secrets(self, rewrite: Callable[[McpServerRecord], McpServerRecord]) -> int:
        async with self._engine.begin() as conn:
            rows = (
                (await conn.execute(select(mcp_servers_table).order_by(_c.id).with_for_update()))
                .mappings()
                .all()
            )
            for row in rows:
                rewritten = rewrite(_record(row))
                await conn.execute(
                    update(mcp_servers_table)
                    .where(_c.id == row["id"])
                    .values(url=rewritten.url, headers=_headers_json(rewritten.headers))
                )
            return len(rows)


__all__ = ["DB_SCHEMA", "SqlMcpServerStore", "mcp_servers_table", "metadata_obj"]
