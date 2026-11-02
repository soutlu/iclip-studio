"""MCP 服务用例：列出、建、改、删，试连（已保存的记下结果与发现的工具，没保存的什么都不存），给运行时取
明文的连接参数，换钥。规则见 ``rules``；「在用时不能停用、不能删」在 ``McpServerStore.edit`` 锁住那一行之后判。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import replace

import structlog

from agent_runtime.agent_usage import AgentUsage, in_use_message, usages_out
from agent_runtime.config.mcp_servers.index import McpServerIndex
from agent_runtime.config.mcp_servers.models import (
    McpEndpoint,
    McpHeader,
    McpProbeResult,
    McpServerRecord,
    McpTool,
    RuntimeMcpServer,
)
from agent_runtime.config.mcp_servers.repository import McpProbe, McpServerStore, McpUsages
from agent_runtime.config.mcp_servers.rules import (
    check_server_id,
    check_timeout,
    check_url,
    clean_description,
    clean_name,
    decrypt_headers,
    encrypt_headers,
    masked_headers,
    plain_headers,
    url_hash,
)
from agent_runtime.config.mcp_servers.schemas import (
    McpCheckIn,
    McpCheckOut,
    McpHeaderOut,
    McpLastCheckOut,
    McpServerCreateIn,
    McpServerOut,
    McpServersOut,
    McpServerUpdateIn,
    McpToolOut,
)
from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.secrets import CredentialCipher

_logger = structlog.stdlib.get_logger(__name__)


def _tools_out(tools: Sequence[McpTool] | None) -> list[McpToolOut] | None:
    if tools is None:
        return None
    return [McpToolOut(name=one.name, description=one.description) for one in tools]


def _check_out(result: McpProbeResult) -> McpCheckOut:
    return McpCheckOut(
        ok=result.ok,
        elapsed_ms=result.elapsed_ms,
        reason=result.reason,
        tools=_tools_out(result.tools),
    )


async def rotate_mcp_server_keys(store: McpServerStore, *, cipher: CredentialCipher) -> int:
    """把全部 MCP 服务的地址与请求头的值改用第一个 key 重新加密，交回改了几个服务。供 ``agent_runtime.admin``
    换钥用。"""

    return await store.rewrite_secrets(
        lambda record: replace(
            record,
            url=cipher.rotate(record.url),
            headers=tuple(
                McpHeader(name=one.name, value=cipher.rotate(one.value)) for one in record.headers
            ),
        )
    )


class McpServerService:
    """``probe`` 由组合根接上，每次调用都是一次真实的连接；``usages`` 由组合根接到 agent 配置域，回答哪些
    agent 挂着哪个服务。``index`` 是组合根建的服务名册，本服务是它唯一的写入方：``load_index`` 整份读一次，
    之后建、改、删、试连在写入提交之后跟着换。"""

    def __init__(
        self,
        store: McpServerStore,
        *,
        cipher: CredentialCipher,
        probe: McpProbe,
        usages: McpUsages,
        index: McpServerIndex,
    ) -> None:
        self._store = store
        self._cipher = cipher
        self._probe = probe
        self._usages = usages
        self._index = index

    async def load_index(self) -> None:
        """从库里整份读一次服务名册，运行时服务启动时调。"""

        self._index.replace(await self._store.list())

    async def list(self) -> McpServersOut:
        """全部服务，按建立时刻从新到旧，带打码的请求头、上一次试连、发现的工具与挂着它的 agent。"""

        users = await self._usages.mcp_server_users()
        return McpServersOut(
            items=[
                self._out(record, users.get(record.id, ())) for record in await self._store.list()
            ]
        )

    async def get(self, server_id: str) -> McpServerOut:
        record = await self._require(server_id)
        return self._out(record, (await self._usages.mcp_server_users()).get(server_id, ()))

    async def create(self, body: McpServerCreateIn, *, by: uuid.UUID) -> McpServerOut:
        """建一个服务，不连它；地址与请求头的值加密存。标识、名称、地址、时限或请求头不合格是
        ``ValidationFailed``，标识已被占用、地址或名称与已有的服务重复是 ``Conflict``。"""

        server_id = check_server_id(body.id)
        url = check_url(body.url)
        await self._store.insert(
            server_id,
            name=clean_name(body.name),
            description=clean_description(body.description),
            url=self._cipher.encrypt(url),
            url_hash=url_hash(url),
            transport=body.transport,
            timeout_seconds=check_timeout(body.timeout_seconds),
            headers=encrypt_headers(plain_headers(body.headers), self._cipher),
            enabled=body.enabled,
            by=by,
        )
        await self._refresh_index(server_id)
        return await self.get(server_id)

    async def update(
        self, server_id: str, body: McpServerUpdateIn, *, by: uuid.UUID
    ) -> McpServerOut:
        """改给了的项，不连它。没给地址沿用原来的，给了就重新加密。给了请求头就整份替换，没给值的沿用同名
        请求头原来的值。换了地址或连接方式时，上一次试连与发现的工具一起清掉（那是另一个服务的了）。某个
        agent 的草稿或当前版本还挂着它时停用、地址或名称与别的服务重复是 ``Conflict``。"""

        async with self._store.edit(server_id) as editor:
            record = editor.record
            enabled = record.enabled if body.enabled is None else body.enabled
            if record.enabled and not enabled:
                await self._require_unused(record)
            url, hashed = record.url, record.url_hash
            if body.url is not None:
                plain_url = check_url(body.url)
                url, hashed = self._cipher.encrypt(plain_url), url_hash(plain_url)
            transport = record.transport if body.transport is None else body.transport
            headers = record.headers
            if body.headers is not None:
                current = {one.name: one.value for one in self._plain(record)}
                headers = encrypt_headers(plain_headers(body.headers, current), self._cipher)
            await editor.update(
                name=record.name if body.name is None else clean_name(body.name),
                description=record.description
                if body.description is None
                else clean_description(body.description),
                url=url,
                url_hash=hashed,
                transport=transport,
                timeout_seconds=record.timeout_seconds
                if body.timeout_seconds is None
                else check_timeout(body.timeout_seconds),
                headers=headers,
                enabled=enabled,
                clear_check=(hashed, transport) != (record.url_hash, record.transport),
                by=by,
            )
        await self._refresh_index(server_id)
        return await self.get(server_id)

    async def delete(self, server_id: str) -> None:
        """删一个服务；某个 agent 的草稿或当前版本还挂着它是 ``Conflict``。"""

        async with self._store.edit(server_id) as editor:
            await self._require_unused(editor.record)
            await editor.delete()
        self._index.remove(server_id)

    async def check(self, server_id: str) -> McpCheckOut:
        """按已保存的配置连一次，列出工具，记下结果：通了换掉发现的工具，没通只记原因、发现的工具不动。"""

        record = await self._require(server_id)
        result = await self._run_probe(server_id, self._endpoint(record))
        recorded = await self._store.record_check(
            server_id,
            ok=result.ok,
            elapsed_ms=result.elapsed_ms,
            reason=result.reason,
            tools=result.tools if result.ok else None,
        )
        if not recorded:
            raise NotFound("MCP 服务不存在")
        await self._refresh_index(server_id)
        return _check_out(result)

    async def check_unsaved(self, body: McpCheckIn) -> McpCheckOut:
        """按一份还没保存的配置连一次，什么都不存。给了 ``serverId`` 时没给地址就用那个服务的地址，没给值的
        请求头取那个服务里同名的原值；没给 ``serverId`` 又没给地址是 ``ValidationFailed``。"""

        current: Mapping[str, str] | None = None
        saved_url: str | None = None
        if body.server_id is not None:
            record = await self._require(body.server_id)
            current = {one.name: one.value for one in self._plain(record)}
            saved_url = self._cipher.decrypt(record.url)
        if body.url is not None:
            url = check_url(body.url)
        elif saved_url is not None:
            url = saved_url
        else:
            raise ValidationFailed("请填写地址")
        endpoint = McpEndpoint(
            url=url,
            transport=body.transport,
            timeout_seconds=check_timeout(body.timeout_seconds),
            headers={one.name: one.value for one in plain_headers(body.headers, current)},
        )
        return _check_out(await self._run_probe(body.server_id, endpoint))

    async def runtime_server(self, server_id: str) -> RuntimeMcpServer | None:
        """运行时挂一个服务要的东西，地址与请求头解密成明文；没有这个服务给 ``None``。启没启用不在这里判（agent
        编译时已查）。"""

        record = await self._store.get(server_id)
        if record is None:
            return None
        return RuntimeMcpServer(
            id=record.id,
            name=record.name,
            endpoint=self._endpoint(record),
            updated_at=record.updated_at,
        )

    async def record(self, server_id: str) -> McpServerRecord | None:
        """一个服务的存储形态（地址与请求头仍是密文），供 agent 配置查引用；没有给 ``None``。"""

        return await self._store.get(server_id)

    async def _run_probe(self, server_id: str | None, endpoint: McpEndpoint) -> McpProbeResult:
        result = await self._probe.probe(endpoint)
        if not result.ok:
            _logger.info("MCP 服务试连没通过", server_id=server_id, reason=result.reason)
        return result

    async def _refresh_index(self, server_id: str) -> None:
        # 写入已提交，按库里此刻的那一行换名册；读到时已被并发删掉就从名册里去掉。
        record = await self._store.get(server_id)
        if record is None:
            self._index.remove(server_id)
        else:
            self._index.put(record)

    async def _require(self, server_id: str) -> McpServerRecord:
        record = await self._store.get(server_id)
        if record is None:
            raise NotFound("MCP 服务不存在")
        return record

    async def _require_unused(self, record: McpServerRecord) -> None:
        users = (await self._usages.mcp_server_users()).get(record.id, ())
        if users:
            raise Conflict(in_use_message(f"MCP 服务 {record.name} ", users))

    def _plain(self, record: McpServerRecord) -> tuple[McpHeader, ...]:
        return decrypt_headers(record.headers, self._cipher)

    def _endpoint(self, record: McpServerRecord) -> McpEndpoint:
        return McpEndpoint(
            url=self._cipher.decrypt(record.url),
            transport=record.transport,
            timeout_seconds=record.timeout_seconds,
            headers={one.name: one.value for one in self._plain(record)},
        )

    def _out(self, record: McpServerRecord, users: Sequence[AgentUsage]) -> McpServerOut:
        check = record.check
        return McpServerOut(
            id=record.id,
            name=record.name,
            description=record.description,
            url=self._cipher.decrypt(record.url),
            transport=record.transport,
            timeout_seconds=record.timeout_seconds,
            headers=[
                McpHeaderOut(name=one.name, value=one.value)
                for one in masked_headers(self._plain(record))
            ],
            enabled=record.enabled,
            last_check=None
            if check is None
            else McpLastCheckOut(
                ok=check.ok,
                elapsed_ms=check.elapsed_ms,
                reason=check.reason,
                checked_at=check.checked_at,
            ),
            tools=_tools_out(record.tools),
            used_by=usages_out(users),
            created_by=record.created_by,
            updated_by=record.updated_by,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


__all__ = ["McpServerService", "rotate_mcp_server_keys"]
