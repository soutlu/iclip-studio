"""Agent 配置测试的替身：一张只有两个测试插件的登记表。插件名都是测试自己起的，不引用真实插件。"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from iclip.domains.agent_config.public import Problem, problems_from_errors

NOTES = "notes"
"""没有依赖的测试插件，参数 ``limit`` 是正整数。"""

SEARCH = "search"
"""要求同挂 ``notes`` 的测试插件，没有参数。"""


class NotesParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    limit: int = Field(default=10, gt=0)


class NoParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FakePlugins:
    """``PluginDirectory`` 的替身：插件名 →（要求同挂的插件，参数模型）。"""

    def __init__(
        self, plugins: Mapping[str, tuple[tuple[str, ...], type[BaseModel]]] | None = None
    ) -> None:
        self._plugins = (
            dict(plugins)
            if plugins is not None
            else {NOTES: ((), NotesParameters), SEARCH: ((NOTES,), NoParameters)}
        )

    def available(self) -> frozenset[str]:
        return frozenset(self._plugins)

    def requires(self, name: str) -> tuple[str, ...]:
        return self._plugins[name][0]

    def parameter_problems(self, name: str, parameters: Mapping[str, Any]) -> tuple[Problem, ...]:
        try:
            self._plugins[name][1].model_validate(parameters)
        except ValidationError as exc:
            return problems_from_errors(exc.errors())
        return ()


__all__ = ["NOTES", "SEARCH", "FakePlugins", "NoParameters", "NotesParameters"]
