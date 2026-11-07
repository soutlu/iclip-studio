from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from cue.config.agent_config.public import (
    McpServerFacts,
    ModelFacts,
    PluginFacts,
    Problem,
    ProviderFacts,
    SkillFacts,
    problems_from_errors,
)
from cue.config.mcp_servers.public import McpServerService
from cue.config.model_providers.public import ModelProviderService
from cue.config.skills.public import STATUS_ARCHIVED, SkillsService
from cue.plugins.base import PluginRegistry


class ProviderDirectory:
    def __init__(self, service: ModelProviderService) -> None:
        self._service = service

    async def provider(self, name: str) -> ProviderFacts | None:
        found = await self._service.resolved(name)
        if found is None:
            return None
        return ProviderFacts(
            id=found.provider.id,
            name=found.provider.name,
            enabled=found.provider.enabled,
            credential_ids=frozenset(found.credential_ids),
            default_credential_id=found.provider.default_credential_id,
            models=tuple(
                ModelFacts(
                    name=model.name, enabled=model.enabled, thinking=model.properties.thinking
                )
                for model in found.models
                if model.type == "llm"
            ),
        )


class RegistryPluginDirectory:
    def __init__(self, registry: PluginRegistry) -> None:
        self._registry = registry
        self._requires = {name: plugin.required_plugins() for name, plugin in registry.items()}
        self._parameters = {name: plugin.parameters_model() for name, plugin in registry.items()}

    def available(self) -> frozenset[str]:
        return frozenset(self._registry)

    def requires(self, name: str) -> tuple[str, ...]:
        return self._requires[name]

    def parameter_problems(self, name: str, parameters: Mapping[str, Any]) -> tuple[Problem, ...]:
        try:
            self._parameters[name].model_validate(parameters)
        except ValidationError as exc:
            return problems_from_errors(exc.errors())
        return ()

    def catalog(self) -> tuple[PluginFacts, ...]:
        return tuple(
            PluginFacts(
                name=name,
                label=plugin.label,
                description=plugin.summary,
                requires=self._requires[name],
                parameters_schema=self._parameters[name].model_json_schema(),
            )
            for name, plugin in self._registry.items()
        )


class McpServerDirectory:
    def __init__(self, service: McpServerService) -> None:
        self._service = service

    async def server(self, server_id: str) -> McpServerFacts | None:
        found = await self._service.record(server_id)
        if found is None:
            return None
        return McpServerFacts(
            id=found.id,
            name=found.name,
            enabled=found.enabled,
            tools=None if found.tools is None else tuple(tool.name for tool in found.tools),
        )


class LibrarySkillDirectory:
    def __init__(self, service: SkillsService) -> None:
        self._service = service

    async def skills(self) -> tuple[SkillFacts, ...]:
        return tuple(
            SkillFacts(
                id=skill.id,
                name=skill.name,
                archived=skill.status == STATUS_ARCHIVED,
                latest_version_id=skill.latest_version_id,
            )
            for skill in await self._service.catalog()
        )


__all__ = [
    "LibrarySkillDirectory",
    "McpServerDirectory",
    "ProviderDirectory",
    "RegistryPluginDirectory",
]
