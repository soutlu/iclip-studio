"""需求单测试要开对话认领：开对话要有发布过、上首页菜单的 agent。"""

from __future__ import annotations

import pytest

from tests.helpers.agents import CONVERSABLE_SEEDS, AgentSeed


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return CONVERSABLE_SEEDS
