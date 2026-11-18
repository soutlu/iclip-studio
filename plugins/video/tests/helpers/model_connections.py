from __future__ import annotations

from collections.abc import Mapping

from agent_runtime.errors import ModelUnavailable
from agent_runtime.model_connections import ModelConnection


class FakeModelConnections:
    def __init__(
        self, connections: Mapping[tuple[str, str], ModelConnection] | None = None
    ) -> None:
        self.connections = dict(connections or {})
        self.asked: list[tuple[str, str, str | None]] = []

    async def __call__(
        self, declaration: str, model: str, model_group: str | None
    ) -> ModelConnection:
        self.asked.append((declaration, model, model_group))
        found = self.connections.get((declaration, model))
        if found is None:
            raise ModelUnavailable(f"配置页的火山方舟里没有启用的模型 {model}（或没有默认密钥）")
        return found


__all__ = ["FakeModelConnections"]
