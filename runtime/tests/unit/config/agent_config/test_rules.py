"""Agent 标识规则：格式之外，``/agents/`` 下固定路径的那几段不能用作新 agent 的标识。"""

from __future__ import annotations

import pytest

from agent_runtime.config.agent_config.models import RESERVED_AGENT_IDS
from agent_runtime.config.agent_config.rules import agent_id_problem, check_agent_id
from agent_runtime.errors import ValidationFailed


@pytest.mark.parametrize("agent_id", sorted(RESERVED_AGENT_IDS))
def test_a_reserved_word_cannot_name_a_new_agent(agent_id: str) -> None:
    with pytest.raises(ValidationFailed, match="保留词"):
        check_agent_id(agent_id)
    assert agent_id_problem(agent_id) == f"{agent_id} 是保留词，不能用作标识"


def test_the_reserved_words_are_the_fixed_paths_under_agents() -> None:
    assert {"plugins", "order", "import"} <= RESERVED_AGENT_IDS


def test_an_existing_agent_is_only_checked_for_format() -> None:
    assert agent_id_problem("plugins", new=False) is None
    assert agent_id_problem("Bad_Id", new=False) is not None


def test_an_ordinary_id_passes() -> None:
    assert check_agent_id("director") == "director"
