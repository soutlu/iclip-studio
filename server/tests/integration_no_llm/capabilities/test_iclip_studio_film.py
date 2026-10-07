"""工程文件的检查经真实 Postgres 文件存储与素材台账的往返。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.capability import IclipStudio
from iclip.capabilities.iclip_studio.film.film import FILM_PATH, RUN_PATH
from iclip.capabilities.iclip_studio.ports import SampledVideo
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import FileSpace
from iclip.platform.material_ledger.pg import PgMaterialLedger
from iclip.platform.material_ledger.store import Material
from tests.helpers.film import FILM, GIVEN_IMAGES, RUN, SHOE_FRONT
from tests.helpers.pg import truncate_clean

USER = uuid.UUID("55555555-5555-5555-5555-555555555555")


class NoSampler:
    async def duration_seconds(self, video_url: str) -> float:
        raise AssertionError("不该读视频")

    async def sample(self, video_url: str) -> SampledVideo:
        raise AssertionError("不该抽帧")


class NoShared:
    async def get(self, video_url: str) -> str | None:
        raise AssertionError("不该查共用的拆解")

    async def put(self, video_url: str, document: str) -> None:
        raise AssertionError("不该存共用的拆解")


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await truncate_clean(conn, ("agent_runtime.workspace_files", "agent_runtime.materials"))
    yield engine
    await engine.dispose()


@pytest.fixture
def conversation_id() -> str:
    return f"c-{uuid.uuid4().hex[:8]}"


def make_deps(conversation_id: str) -> AgentRunDeps:
    return AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=USER,
            permissions=frozenset({"agent:run"}),
            audit_label="logan",
            api_key_id=None,
        ),
        conversation_id=conversation_id,
        user_name="logan",
    )


async def call_once(
    capability: IclipStudio[object], conversation_id: str, tool_name: str, args: dict[str, Any]
) -> tuple[list[RetryPromptPart], list[str]]:
    """模型只调一次工具，返回它收到的退回单和工具结果。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="c1")])
        return ModelResponse(parts=[TextPart("好")])

    result = await Agent(FunctionModel(script), capabilities=[capability]).run(
        "写工程文件。", deps=make_deps(conversation_id)
    )
    parts = [part for message in result.all_messages() for part in message.parts]
    return (
        [part for part in parts if isinstance(part, RetryPromptPart)],
        [str(part.content) for part in parts if isinstance(part, ToolReturnPart)],
    )


def make_studio(engine: AsyncEngine) -> tuple[IclipStudio[object], PgFileStore, PgMaterialLedger]:
    files = PgFileStore(engine)
    ledger = PgMaterialLedger(engine)
    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    capability = IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdown=VideoBreakdown(model=model, sampler=NoSampler()),
        shared=NoShared(),
        ledger=ledger,
    )
    return capability, files, ledger


async def test_check_round_trips_through_postgres(
    engine: AsyncEngine, conversation_id: str
) -> None:
    capability, files, ledger = make_studio(engine)
    namespace = f"{USER}/{conversation_id}"
    await files.write(namespace, FILM_PATH, FILM)
    await files.write(namespace, RUN_PATH, RUN)
    await ledger.record(namespace, [Material(url=url, kind="image") for url in GIVEN_IMAGES])

    retries, (checked,) = await call_once(capability, conversation_id, "check_film", {})
    assert retries == []
    assert checked.startswith("检查通过：6 个生图节点，1 次视频请求。")


async def test_an_address_the_conversation_never_received_fails_the_check(
    engine: AsyncEngine, conversation_id: str
) -> None:
    capability, files, ledger = make_studio(engine)
    namespace = f"{USER}/{conversation_id}"
    await files.write(namespace, FILM_PATH, FILM)
    await ledger.record(namespace, [Material(url=SHOE_FRONT, kind="video")])

    retries, (checked,) = await call_once(capability, conversation_id, "check_film", {})

    assert retries == []
    assert checked.startswith("检查没通过")
    assert "src 不是这段对话里的图片" in checked
