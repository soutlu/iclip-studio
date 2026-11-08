from __future__ import annotations

import pytest

from tests.helpers.agents import CONVERSABLE_SEEDS, AgentSeed


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return CONVERSABLE_SEEDS
