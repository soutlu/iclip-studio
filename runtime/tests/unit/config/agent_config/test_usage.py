"""子 agent 的两种身份：一个 agent 有没有子 agent 看它自己的草稿与当前版本合在一起；是不是别人的子 agent 看
别的 agent 的草稿或当前版本，自己写自己不算。agent 列表的 ``hasSubagents`` 与 ``isSubagent`` 就按这两条算。"""

from __future__ import annotations

import uuid

from agent_runtime.config.agent_config.models import AgentRefs, ConfigRefs
from agent_runtime.config.agent_config.usage import subagent_users


def refs(
    agent_id: str,
    *,
    draft: tuple[str, ...] = (),
    active: tuple[str, ...] | None = None,
) -> AgentRefs:
    def config_refs(subagents: tuple[str, ...]) -> ConfigRefs:
        return ConfigRefs(
            provider=None,
            model=None,
            credential_id=None,
            skill_ids=(),
            subagents=subagents,
            mcp_servers=(),
        )

    return AgentRefs(
        agent_id=agent_id,
        name=agent_id,
        description="",
        status="active",
        active_version_id=uuid.uuid4() if active is not None else None,
        draft=config_refs(draft),
        active=config_refs(active) if active is not None else None,
    )


def test_subagents_combine_the_draft_and_the_active_version() -> None:
    assert refs("a").subagents == frozenset()
    assert refs("a", draft=("x",)).subagents == {"x"}
    assert refs("a", active=("y",)).subagents == {"y"}
    assert refs("a", draft=("x",), active=("x", "y")).subagents == {"x", "y"}


def test_an_agent_is_a_subagent_when_another_draft_or_active_version_binds_it() -> None:
    agents = (
        refs("by-draft", draft=("helper",)),
        refs("by-version", draft=(), active=("other",)),
        refs("self", draft=("self",)),
        refs("helper"),
        refs("other"),
    )

    assert [one.agent_id for one in subagent_users(agents, "helper")] == ["by-draft"]
    assert [one.agent_id for one in subagent_users(agents, "other")] == ["by-version"]
    assert subagent_users(agents, "self") == ()
