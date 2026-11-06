from __future__ import annotations

from collections.abc import Mapping

from agent_runtime.errors import ModelUnavailable
from agent_runtime.model_connections import ModelConnection


class FakeModelConnections:
    def __init__(
        self, connections: Mapping[tuple[str, str], ModelConnection] | None = None
    ) -> None:
        self.connections = dict(connections or {})
        self.asked: list[tuple[str, str]] = []

    async def __call__(self, declaration: str, model: str) -> ModelConnection:
        self.asked.append((declaration, model))
        found = self.connections.get((declaration, model))
        if found is None:
            raise ModelUnavailable(f"测试里没给 {declaration}/{model} 的连接")
        return found
