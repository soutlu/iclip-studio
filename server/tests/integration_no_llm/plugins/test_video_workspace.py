"""video 能力经真实 Postgres 文件存储与素材台账的往返：拆解文档落库。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any

import pytest
from agent_runtime.file_store.pg import PgFileStore
from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.pg import PgMaterialLedger
from agent_runtime.material_ledger.store import Material
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.agents.public import AgentRunDeps
from iclip.platform.db.engine import build_engine
from iclip.plugins.video.capability import Video
from iclip.plugins.video_document import video_doc_path
from iclip.plugins.workspace.scope import workspace_namespace
from tests.helpers.pg import truncate_clean
from tests.helpers.plugins import with_requirements
from tests.helpers.shot_video import FakeUnderstanding

USER = uuid.UUID("44444444-4444-4444-4444-444444444444")
VIDEO = "https://cdn.test/ref.mp4"
DOCUMENT = "## 逐镜拉片表\n**[00:00.000-00:08.000]** 她走进门厅。"


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = build_engine(migrated_pg)
    async with engine.begin() as conn:
        await truncate_clean(conn, ("agent_runtime.workspace_files", "agent_runtime.materials"))
    yield engine
    await engine.dispose()


@pytest.fixture
def conversation_id() -> str:
    return f"c-{uuid.uuid4().hex[:8]}"


def make_deps(conversation_id: str) -> AgentRunDeps:
    return AgentRunDeps(user_id=USER, conversation_id=conversation_id, user_name="logan")


async def call_once(
    capability: Video[object], conversation_id: str, tool_name: str, args: str | dict[str, Any]
) -> list[ToolReturnPart]:
    """模型只调一次工具，返回它收到的退回单。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="c1")])
        return ModelResponse(parts=[TextPart("好")])

    result = await Agent(
        FunctionModel(script), capabilities=with_requirements(capability, capability.space)
    ).run("处理参考素材。", deps=make_deps(conversation_id))
    return [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.outcome == "retried"
    ]


def make_video(engine: AsyncEngine) -> tuple[Video[object], PgFileStore, PgMaterialLedger]:
    files = PgFileStore(engine)
    ledger = PgMaterialLedger(engine)
    capability = Video[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=ledger,
        understanding=FakeUnderstanding(document=DOCUMENT),
    )
    return capability, files, ledger


async def test_parse_round_trips_through_postgres(
    engine: AsyncEngine, conversation_id: str
) -> None:
    capability, files, ledger = make_video(engine)
    namespace = f"{USER}/{conversation_id}"
    await ledger.record(namespace, [Material(url=VIDEO, kind="video")])

    assert await call_once(capability, conversation_id, "video_parser", {"video_url": VIDEO}) == []
    parsed = await files.read(namespace, video_doc_path(VIDEO))
    assert parsed is not None
    assert parsed.content == DOCUMENT
