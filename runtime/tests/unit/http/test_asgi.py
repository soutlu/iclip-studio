"""启动入口：没配插件包就是空登记表；配了就交回外壳，lifespan 启动时先打开插件包、用它的绑定函数建 app 再
启动 app，关停时倒序收尾，任一步失败都按 lifespan 协议报失败并收拾已打开的。"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncGenerator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from agent_runtime.http.asgi import CONFIG_ENV, PluginsAtStartup, app_from_env
from agent_runtime.plugins.base import PluginBinder, PluginHost, PluginRegistry
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger

FERNET_KEY = base64.urlsafe_b64encode(b"asgi-test-key-0123456789abcdefgh").decode()


class Lifespan:
    """按 ASGI lifespan 协议驱动一个 app：发 startup / shutdown，收它的答复。"""

    def __init__(self, app: PluginsAtStartup) -> None:
        self._inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._outbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.task = asyncio.create_task(
            app(
                {"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}},
                self._inbox.get,
                self._send,
            )
        )

    async def _send(self, message: Mapping[str, Any]) -> None:
        await self._outbox.put(dict(message))

    async def step(self, kind: str) -> dict[str, Any]:
        await self._inbox.put({"type": f"lifespan.{kind}"})
        return await asyncio.wait_for(self._outbox.get(), timeout=5)


class Steps:
    """记下插件包与 app 各自起停的先后。"""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.hosts: list[PluginHost] = []

    def plugins(
        self, *, fail: bool = False
    ) -> Callable[[], AbstractAsyncContextManager[PluginBinder]]:
        @asynccontextmanager
        async def opened() -> AsyncGenerator[PluginBinder]:
            self.events.append("plugins opened")
            if fail:
                raise RuntimeError("插件包起不来：后端连不上")
            try:
                yield self.bind
            finally:
                self.events.append("plugins closed")

        return opened

    def bind(self, host: PluginHost) -> PluginRegistry:
        self.hosts.append(host)
        return {}

    def build(self, bind: PluginBinder, *, fail: bool = False) -> FastAPI:
        if fail:
            raise RuntimeError("出图工具要的模型后端没接")
        registry = bind(PluginHost(files=FakeFileStore(), ledger=FakeMaterialLedger()))

        @asynccontextmanager
        async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
            self.events.append("app started")
            yield
            self.events.append("app stopped")

        app = FastAPI(lifespan=lifespan)

        @app.get("/plugins")
        async def plugins() -> list[str]:
            return sorted(registry)

        return app


async def test_plugins_open_before_the_app_is_built_and_close_after_it_stops() -> None:
    steps = Steps()
    shell = PluginsAtStartup(steps.plugins(), steps.build)
    lifespan = Lifespan(shell)

    assert await lifespan.step("startup") == {"type": "lifespan.startup.complete"}
    assert steps.events == ["plugins opened", "app started"]
    assert len(steps.hosts) == 1, "app 用插件包交回的绑定函数建登记表"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=shell), base_url="http://runtime.test"
    ) as client:
        answered = await client.get("/plugins")
    assert (answered.status_code, answered.json()) == (200, [])

    assert await lifespan.step("shutdown") == {"type": "lifespan.shutdown.complete"}
    await lifespan.task
    assert steps.events == ["plugins opened", "app started", "app stopped", "plugins closed"]


async def test_plugins_that_fail_to_open_fail_the_startup() -> None:
    steps = Steps()
    lifespan = Lifespan(PluginsAtStartup(steps.plugins(fail=True), steps.build))

    reported = await lifespan.step("startup")

    assert reported["type"] == "lifespan.startup.failed"
    assert "后端连不上" in reported["message"]
    with pytest.raises(RuntimeError, match="后端连不上"):
        await lifespan.task
    assert steps.events == ["plugins opened"]


async def test_an_app_that_fails_to_build_fails_the_startup_and_closes_the_plugins() -> None:
    steps = Steps()
    lifespan = Lifespan(
        PluginsAtStartup(steps.plugins(), lambda bind: steps.build(bind, fail=True))
    )

    reported = await lifespan.step("startup")

    assert reported["type"] == "lifespan.startup.failed"
    assert "模型后端没接" in reported["message"]
    with pytest.raises(RuntimeError, match="模型后端没接"):
        await lifespan.task
    assert steps.events == ["plugins opened", "plugins closed"]


async def test_a_request_before_startup_is_refused() -> None:
    steps = Steps()
    shell = PluginsAtStartup(steps.plugins(), steps.build)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=shell), base_url="http://runtime.test"
    ) as client:
        with pytest.raises(RuntimeError, match="还没启动完"):
            await client.get("/plugins")


CONFIG = """
apps:
  bff:
    key_env: RUNTIME_KEY_BFF
    hooks:
      gate: null
      run_started: null
      turn_started: null
"""


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://nobody:nothing@127.0.0.1:1/never")
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEYS", FERNET_KEY)
    monkeypatch.setenv("RUNTIME_KEY_BFF", "b" * 40)
    return monkeypatch


def test_without_a_plugins_section_the_app_has_an_empty_registry(
    tmp_path: Path, env: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "config.yaml"
    path.write_text(CONFIG, encoding="utf-8")
    env.setenv(CONFIG_ENV, str(path))

    assert isinstance(app_from_env(), FastAPI)


def test_a_plugins_section_gives_the_startup_shell(tmp_path: Path, env: pytest.MonkeyPatch) -> None:
    path = tmp_path / "config.yaml"
    path.write_text(
        CONFIG + "plugins:\n  factory: contextlib:nullcontext\n  config: {}\n", encoding="utf-8"
    )
    env.setenv(CONFIG_ENV, str(path))

    assert isinstance(app_from_env(), PluginsAtStartup)
