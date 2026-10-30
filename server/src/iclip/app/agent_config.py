"""Agent 配置的三个查询端口接到模型供应商、插件登记表与技能库。

插件只从组合根的登记表读：哪些名字可用、要求同挂哪些、参数按插件类 ``from_spec`` 的签名校验；这里不另列插件。"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from iclip.app.plugin_registry import PluginRegistry
from iclip.domains.agent_config.public import (
    ModelFacts,
    PluginFacts,
    Problem,
    ProviderFacts,
    SkillFacts,
    problems_from_errors,
)
from iclip.domains.model_providers.public import ModelProviderService
from iclip.domains.skills.public import STATUS_ARCHIVED, SkillsService


class ProviderDirectory:
    """``ModelDirectory`` 的实现：按引用名读模型供应商域里的供应商，只给 llm 模型。"""

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
    """``PluginDirectory`` 的实现：读组合根的插件登记表。

    可挂的名字是登记的插件类的 serialization name；要求同挂的插件取自 ``get_ordering().requires``，
    参数按插件类 ``from_spec`` 的签名校验。这些都在构造时（启动期）读一遍。
    """

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


class LibrarySkillDirectory:
    """``SkillDirectory`` 的实现：读技能库。"""

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


__all__ = ["LibrarySkillDirectory", "ProviderDirectory", "RegistryPluginDirectory"]
