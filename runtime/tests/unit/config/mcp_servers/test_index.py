"""MCP 服务名册：启动时从库里整份读；建、改、试连提交之后按库里那一行换，删掉之后去掉；写入没成的不动。

仓储是内存里的替身：``edit`` 里的修改在块正常结束时才生效，名册若在提交前就读库会读到旧的那一行。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet

from agent_runtime.agent_usage import AgentUsage
from agent_runtime.config.mcp_servers.index import McpServerIndex
from agent_runtime.config.mcp_servers.models import (
    McpCheck,
    McpEndpoint,
    McpHeader,
    McpProbeResult,
    McpServerRecord,
    McpTool,
    McpTransport,
)
from agent_runtime.config.mcp_servers.schemas import McpServerCreateIn, McpServerUpdateIn
from agent_runtime.config.mcp_servers.service import McpServerService
from agent_runtime.errors import Conflict, NotFound
from agent_runtime.secrets import CredentialCipher

BY = uuid.uuid4()
NOW = datetime(2026, 11, 1, tzinfo=UTC)
URL = "https://mcp.example.com/mcp"
TOOLS = (McpTool(name="search", description="搜索云文档。"), McpTool(name="read", description=None))


def record(
    server_id: str = "docs",
    name: str = "飞书文档",
    *,
    tools: tuple[McpTool, ...] | None = None,
    enabled: bool = True,
) -> McpServerRecord:
    return McpServerRecord(
        id=server_id,
        name=name,
        description="",
        url=URL,
        transport="streamable_http",
        timeout_seconds=30,
        headers=(),
        enabled=enabled,
        check=None,
        tools=tools,
        created_by=BY,
        updated_by=BY,
        created_at=NOW,
        updated_at=NOW,
    )


class FakeStore:
    """``McpServerStore`` 的内存替身。"""

    def __init__(self, *records: McpServerRecord) -> None:
        self.rows: dict[str, McpServerRecord] = {one.id: one for one in records}

    async def list(self) -> tuple[McpServerRecord, ...]:
        return tuple(self.rows.values())

    async def get(self, server_id: str) -> McpServerRecord | None:
        return self.rows.get(server_id)

    async def insert(
        self,
        server_id: str,
        *,
        name: str,
        description: str,
        url: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        by: uuid.UUID,
    ) -> None:
        if server_id in self.rows:
            raise Conflict("标识已被占用")
        self.rows[server_id] = replace(
            record(server_id, name, enabled=enabled),
            description=description,
            url=url,
            transport=transport,
            timeout_seconds=timeout_seconds,
            headers=tuple(headers),
        )

    @asynccontextmanager
    async def edit(self, server_id: str) -> AsyncGenerator[FakeEditor]:
        found = self.rows.get(server_id)
        if found is None:
            raise NotFound("MCP 服务不存在")
        editor = FakeEditor(found)
        yield editor
        # 块正常结束才「提交」。
        if editor.deleted:
            del self.rows[server_id]
        elif editor.staged is not None:
            self.rows[server_id] = editor.staged

    async def record_check(
        self,
        server_id: str,
        *,
        ok: bool,
        elapsed_ms: int,
        reason: str | None,
        tools: Sequence[McpTool] | None,
    ) -> bool:
        found = self.rows.get(server_id)
        if found is None:
            return False
        self.rows[server_id] = replace(
            found,
            check=McpCheck(ok=ok, elapsed_ms=elapsed_ms, reason=reason, checked_at=NOW),
            tools=found.tools if tools is None else tuple(tools),
        )
        return True

    async def rewrite_headers(
        self, rewrite: Callable[[McpServerRecord], Sequence[McpHeader]]
    ) -> int:
        raise NotImplementedError


@dataclass
class FakeEditor:
    record: McpServerRecord
    staged: McpServerRecord | None = None
    deleted: bool = False

    async def update(
        self,
        *,
        name: str,
        description: str,
        url: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        clear_check: bool,
        by: uuid.UUID,
    ) -> None:
        self.staged = replace(
            self.record,
            name=name,
            description=description,
            url=url,
            transport=transport,
            timeout_seconds=timeout_seconds,
            headers=tuple(headers),
            enabled=enabled,
            check=None if clear_check else self.record.check,
            tools=None if clear_check else self.record.tools,
        )

    async def delete(self) -> None:
        self.deleted = True


@dataclass
class FakeProbe:
    result: McpProbeResult

    async def probe(self, endpoint: McpEndpoint) -> McpProbeResult:
        return self.result


@dataclass
class FakeUsages:
    users: dict[str, tuple[AgentUsage, ...]]

    async def mcp_server_users(self) -> Mapping[str, tuple[AgentUsage, ...]]:
        return self.users


REACHED = McpProbeResult(ok=True, elapsed_ms=12, reason=None, tools=TOOLS)
REFUSED = McpProbeResult(ok=False, elapsed_ms=12, reason="401", tools=None)


@dataclass
class Setup:
    store: FakeStore
    probe: FakeProbe
    usages: FakeUsages
    index: McpServerIndex
    service: McpServerService


@pytest.fixture
def setup() -> Setup:
    store = FakeStore()
    probe = FakeProbe(REACHED)
    usages = FakeUsages({})
    index = McpServerIndex()
    service = McpServerService(
        store,
        cipher=CredentialCipher([Fernet.generate_key().decode()]),
        probe=probe,
        usages=usages,
        index=index,
    )
    return Setup(store, probe, usages, index, service)


def tools_of(index: McpServerIndex, server_id: str = "docs") -> dict[str, str | None]:
    found = index.get(server_id)
    assert found is not None
    return dict(found.tools)


async def test_load_reads_every_server_including_disabled_ones(setup: Setup) -> None:
    setup.store.rows = {
        "docs": record(tools=TOOLS),
        "spare": record("spare", "备用", enabled=False),
    }
    setup.index.put(record("gone", "删掉了"))

    await setup.service.load_index()

    assert tools_of(setup.index) == {"search": "搜索云文档。", "read": None}
    spare = setup.index.get("spare")
    assert spare is not None
    assert (spare.name, dict(spare.tools)) == ("备用", {})
    # 整份换：库里没有的不留。
    assert setup.index.get("gone") is None


async def test_create_puts_the_new_server_without_tools(setup: Setup) -> None:
    await setup.service.create(
        McpServerCreateIn(id="docs", name="飞书文档", url=URL, transport="streamable_http"), by=BY
    )

    found = setup.index.get("docs")
    assert found is not None
    assert (found.name, dict(found.tools)) == ("飞书文档", {})


async def test_a_reached_check_brings_in_the_tools_and_a_refused_one_keeps_them(
    setup: Setup,
) -> None:
    setup.store.rows["docs"] = record()

    await setup.service.check("docs")
    assert tools_of(setup.index) == {"search": "搜索云文档。", "read": None}

    setup.probe.result = REFUSED
    await setup.service.check("docs")
    assert tools_of(setup.index) == {"search": "搜索云文档。", "read": None}


async def test_update_takes_the_committed_row(setup: Setup) -> None:
    setup.store.rows["docs"] = record(tools=TOOLS)
    await setup.service.load_index()

    await setup.service.update("docs", McpServerUpdateIn(name="云文档"), by=BY)
    found = setup.index.get("docs")
    assert found is not None
    assert (found.name, dict(found.tools)) == ("云文档", {"search": "搜索云文档。", "read": None})

    # 换了地址：库里的工具清掉了，名册跟着清。
    await setup.service.update(
        "docs", McpServerUpdateIn(url="https://other.example.com/mcp"), by=BY
    )
    assert tools_of(setup.index) == {}


async def test_delete_removes_the_server_and_a_refused_delete_keeps_it(setup: Setup) -> None:
    setup.store.rows["docs"] = record(tools=TOOLS)
    await setup.service.load_index()
    setup.usages.users = {
        "docs": (AgentUsage("director", "导演", in_draft=True, in_active_version=False),)
    }

    with pytest.raises(Conflict):
        await setup.service.delete("docs")
    assert setup.index.get("docs") is not None

    setup.usages.users = {}
    await setup.service.delete("docs")
    assert setup.index.get("docs") is None
