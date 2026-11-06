from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, FunctionModel

from tests.helpers.agents import AgentSeed, SkillSeed
from tests.helpers.app import TEST_MODEL_NAME, new_conversation, settled
from tests.helpers.auth import register_and_login, set_roles_in_db

AGENT_ID = "storyboard"
SKILL = "breakdown"


@pytest.fixture
def seen_tools() -> list[str]:

    return []


@pytest.fixture
def models(seen_tools: list[str]) -> dict[str, FunctionModel]:
    async def peek(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen_tools.extend(tool.name for tool in info.function_tools)
        yield "看完了"

    return {TEST_MODEL_NAME: FunctionModel(stream_function=peek)}


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (
        AgentSeed(
            AGENT_ID,
            skills=(SkillSeed(SKILL, description="把参考视频拆成结构骨架。"),),
        ),
    )


async def test_declared_skill_reaches_the_running_agent(
    client: httpx.AsyncClient, pg_url: str, seen_tools: list[str]
) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "logan@example.com", ["editor"])

    conversation_id = await new_conversation(client, AGENT_ID)
    sent = await client.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": "prm_skill", "content": [{"type": "text", "text": "开始"}]},
    )
    assert sent.status_code == 200, sent.text
    await settled(client, conversation_id)

    assert "load_capability" in seen_tools
    assert "get_skill_reference" in seen_tools
