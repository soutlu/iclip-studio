"""``RegistryPluginDirectory``：agent 配置经它读插件登记表——可挂的名字、要求同挂的插件、参数校验与
配置页列表，都取自插件类的原生 spec 声明。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import pytest
from agent_runtime.assembly.directories import RegistryPluginDirectory
from agent_runtime.config.agent_config.public import Problem
from agent_runtime.plugins.base import CapPlugin, PluginRegistry
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from pydantic_ai.capabilities import Capability


@dataclass
class LimitedPlugin(CapPlugin[Any]):
    """带一个参数的测试插件：真实插件现在都没有参数。"""

    label = "限量"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return "limited"

    @classmethod
    def from_spec(cls, *, limit: int = 10) -> Capability[Any]:
        return Capability[Any](id="limited", instructions=f"最多 {limit} 条。")

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


@pytest.fixture
def registry() -> PluginRegistry:
    return {"limited": LimitedPlugin}


@pytest.fixture
def directory(registry: PluginRegistry) -> RegistryPluginDirectory:
    return RegistryPluginDirectory(registry)


def test_an_unknown_parameter_is_a_problem(directory: RegistryPluginDirectory) -> None:
    assert directory.parameter_problems("limited", {"root": "/tmp"}) == (
        Problem(path="root", message="不认识这个字段"),
    )
    assert directory.parameter_problems("limited", {}) == ()


def test_parameters_are_checked_against_the_from_spec_signature(
    directory: RegistryPluginDirectory,
) -> None:
    assert directory.parameter_problems("limited", {"limit": 3}) == ()
    assert directory.parameter_problems("limited", {}) == ()
    (problem,) = directory.parameter_problems("limited", {"limit": "很多"})
    assert problem.path == "limit"
    (unknown,) = directory.parameter_problems("limited", {"limit": 3, "page": 2})
    assert unknown.path == "page"


def test_a_plugin_that_was_never_bound_fails_loudly() -> None:
    with pytest.raises(RuntimeError, match="workspace 还没绑服务"):
        RegistryPluginDirectory({"workspace": Workspace})
