from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from cue.config.agent_config.public import PluginFacts, Problem, problems_from_errors

NOTES = "notes"

SEARCH = "search"


class NotesParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    limit: int = Field(default=10, gt=0)


class NoParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FakePlugins:
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

    def catalog(self) -> tuple[PluginFacts, ...]:
        return tuple(
            PluginFacts(
                name=name,
                label=f"{name} 插件",
                description=f"测试用的 {name}。",
                requires=requires,
                parameters_schema=parameters.model_json_schema(),
            )
            for name, (requires, parameters) in self._plugins.items()
        )


__all__ = ["NOTES", "SEARCH", "FakePlugins", "NoParameters", "NotesParameters"]
