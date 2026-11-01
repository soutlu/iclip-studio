"""第二个应用接运行时：运行时只配两个应用、不配插件包，应用 ``crm`` 照 docs/runtime-apps.md 的步骤用客户端库开
会话、发消息、跟着两条 WebSocket、读回 transcript；它与应用 ``video`` 互相寻址不到对方的会话。

最后一条在子进程里走运行时的真实启动入口（YAML 没有 ``plugins``），核对进程里没有 import 视频插件包与视频
后端的任何模块：测试进程本身经夹具 import 了后端，只能在干净的进程里看。"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path

import httpx
import pytest
from agent_runtime.app_wire import ActivitiesIn, SessionOpenIn, SessionPromptIn
from agent_runtime.client import RuntimeClient, WorkChangedFrame
from agent_runtime.errors import NotFound
from agent_runtime.http.app import create_app
from agent_runtime.live.frames import Ack, TranscriptOpsFrame, TranscriptResetFrame
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    RuntimeSettings,
)
from agent_runtime.transcript.ops import TextContent, TurnUpsertOp
from agent_runtime.transcript.wire import Subscribe, SubscribePayload
from fastapi import FastAPI
from httpx_ws.transport import ASGIWebSocketTransport
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.agents import model_builder
from tests.helpers.app import TEST_CREDENTIAL_KEY, TEST_MODEL_NAME
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.runtime import says
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    READER_KEY,
    add_model,
    connect_provider,
    publish_agent,
)

VIDEO_KEY = ADMIN_KEY
"""应用 ``video`` 的密钥：它有管理权限，夹具 ``admin`` 经它接供应商、发布 agent。"""

CRM_KEY = READER_KEY
"""第二个应用 ``crm`` 的密钥：没有管理权限、没有回调。"""

AGENT = "director"
REPLY = "答：收到"
WAIT = 10.0
"""等运行跑完、等帧到的上限（秒）。"""

VIDEO_CODE = ("iclip", "iclip_video")
"""视频后端与视频插件包的顶层包名。"""


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says(REPLY)}


@pytest.fixture
def runtime_app(
    engine: AsyncEngine, migrated_pg: str, tmp_path: Path, models: Mapping[str, Model]
) -> FastAPI:
    """两个应用 ``video`` 与 ``crm``，插件登记表是空的（没配插件包时启动入口交的就是空表）。"""

    settings = RuntimeSettings(
        database_url=migrated_pg,
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(id="video", key=VIDEO_KEY, admin=True),
            ResolvedApp(id="crm", key=CRM_KEY, admin=False),
        ),
        agent_runs=AgentRunsSection(skill_cache_dir=tmp_path / "skills"),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    return create_app(
        settings,
        plugins={},
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        engine=engine,
        build_model=model_builder(models),
    )


@pytest.fixture
async def published(admin: httpx.AsyncClient) -> None:
    """``video`` 经管理接口接好供应商与模型、发布一个不挂插件的 ``AGENT``；agent 配置所有应用共用。"""

    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)


def connect(app: FastAPI, key: str) -> RuntimeClient:
    return RuntimeClient("http://runtime.test", key, transport=ASGIWebSocketTransport(app=app))


async def open_session(client: RuntimeClient) -> uuid.UUID:
    session_id = uuid.uuid4()
    await client.open_session(SessionOpenIn(id=session_id, agent_id=AGENT))
    return session_id


async def test_a_second_app_runs_a_session_and_follows_it_on_both_streams(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    async with connect(runtime_app, CRM_KEY) as crm:
        directory = await crm.agents()
        assert [entry.id for entry in directory.items] == [AGENT]

        session_id = await open_session(crm)
        sid = str(session_id)
        activity: list[tuple[str, bool]] = []
        async with (
            crm.connect_events() as events,
            crm.connect_transcript() as channel,
            asyncio.timeout(WAIT),
        ):
            await channel.subscribe(
                Subscribe(
                    id="s1", payload=SubscribePayload(session_id=sid, transcript={"main": "delta"})
                )
            )
            reset = TranscriptResetFrame.model_validate_json((await channel.receive()).text)
            ack = Ack.model_validate_json((await channel.receive()).text)
            assert ack.payload is not None and ack.payload.accepted == (sid,)

            accepted = await crm.submit_prompt(
                session_id,
                SessionPromptIn(
                    prompt_id="prm_crm",
                    content=(TextContent(text="你好"),),
                    user_name="crm-user",
                    agent_id=AGENT,
                ),
                owner=owner,
            )
            assert accepted.prompt_id == "prm_crm"

            while True:
                frame = TranscriptOpsFrame.model_validate_json((await channel.receive()).text)
                assert frame.stream_epoch == reset.stream_epoch
                if any(
                    isinstance(op, TurnUpsertOp) and op.turn.state != "running"
                    for op in frame.payload.ops
                ):
                    break

            async for event in events:
                assert isinstance(event, WorkChangedFrame)
                activity.append((event.event.session_id, event.event.payload.busy))
                if not event.event.payload.busy:
                    break

        page = await crm.transcript_page(session_id, session_agent=AGENT)

    assert activity[0] == (sid, True)
    assert activity[-1] == (sid, False)
    assert [(turn.trigger_prompt_id, turn.state) for turn in page.items] == [
        ("prm_crm", "completed")
    ]
    assert REPLY in page.model_dump_json()


async def test_the_second_app_and_video_cannot_reach_each_others_sessions(
    running: None, published: None, runtime_app: FastAPI
) -> None:
    async with connect(runtime_app, CRM_KEY) as crm, connect(runtime_app, VIDEO_KEY) as video:
        ours = await open_session(crm)
        theirs = await open_session(video)

        with pytest.raises(NotFound):
            await crm.run_status(theirs)
        with pytest.raises(NotFound):
            await crm.transcript_page(theirs, session_agent=AGENT)
        with pytest.raises(NotFound):
            await video.run_status(ours)
        seen = await crm.activities(ActivitiesIn(ids=(ours, theirs)))
        assert set(seen.items) == {ours}

        async with crm.connect_transcript() as channel, asyncio.timeout(WAIT):
            await channel.subscribe(
                Subscribe(
                    id="s1",
                    payload=SubscribePayload(session_id=str(theirs), transcript={"main": "delta"}),
                )
            )
            ack = Ack.model_validate_json((await channel.receive()).text)
    assert ack.payload is not None
    assert (ack.payload.accepted, ack.payload.not_found) == ((), (str(theirs),))


ENTRY_CONFIG = """\
apps:
  video:
    key_env: STUB_VIDEO_APP_KEY
    admin: true
    hooks: {gate: null, run_started: null, turn_started: null}
  crm:
    key_env: STUB_CRM_APP_KEY
    hooks: {gate: null, run_started: null, turn_started: null}
agent_runs:
  skill_cache_dir: SKILL_CACHE
ops:
  log_level: WARNING
"""

ENTRY_PROBE = f"""\
import asyncio, sys
import httpx
from agent_runtime.http.asgi import app_from_env

async def main():
    app = app_from_env()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://runtime.test"
        ) as client:
            found = await client.get("/v1/agents", headers={{"Authorization": "Bearer {CRM_KEY}"}})
            assert found.status_code == 200, found.text

asyncio.run(main())
print("loaded:" + ",".join(sorted(
    name for name in sys.modules if name.split(".")[0] in {VIDEO_CODE!r}
)))
"""


async def test_the_runtime_entry_without_a_plugin_package_loads_no_video_code(
    engine: AsyncEngine, migrated_pg: str, tmp_path: Path
) -> None:
    """真实的启动入口 ``app_from_env`` 读 YAML、建服务、跑 lifespan（连库、起运行驱动）并答一个应用请求，全程
    没有 import ``iclip`` 与 ``iclip_video``；子进程用的是后端的环境，两个包都装着，没被 import 才有意义。

    ``engine`` 只为先清空测试表：子进程用真实的模型装配，不能让它认领别的用例留下的消息。"""

    config = tmp_path / "runtime.yaml"
    config.write_text(
        ENTRY_CONFIG.replace("SKILL_CACHE", str(tmp_path / "skills")), encoding="utf-8"
    )
    env = {
        **os.environ,
        "AGENT_RUNTIME_CONFIG": str(config),
        "DATABASE_URL": migrated_pg,
        "CREDENTIAL_ENCRYPTION_KEYS": TEST_CREDENTIAL_KEY,
        "STUB_VIDEO_APP_KEY": VIDEO_KEY,
        "STUB_CRM_APP_KEY": CRM_KEY,
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        ENTRY_PROBE,
        cwd=tmp_path,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=120)

    assert process.returncode == 0, stderr.decode(errors="replace")
    assert stdout.decode().strip().splitlines()[-1] == "loaded:"
