"""出图插件的生成端口在后端的实现：参数与错误的映射、对话归属，以及每次调用按属主 id 重建主体。

插件登记表按配置登记哪些插件、各插件的依赖与装配，见视频插件包的 ``tests/unit/test_registry.py``。"""

from __future__ import annotations

import uuid
from typing import cast

import pytest
from agent_runtime.assembly.displays import build_display_registry
from agent_runtime.errors import NotFound, ValidationFailed
from agent_runtime.plugins.base import PluginRegistry
from iclip_video.shot_video.ports import ImageRequest, InvalidImageRequest
from pydantic_ai.capabilities import Capability

from iclip.app.image_generations import GenerationsAdapter
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from tests.helpers.generation import make_job
from tests.helpers.identity import FakePrincipals
from tests.helpers.plugins import FixedPlugin

STUDIO_PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
    permissions=frozenset({"agent:run"}),
    audit_label="logan",
)


@pytest.fixture
def dummy() -> Capability[object]:
    return Capability[object](id="dummy", instructions="按镜头表干活。")


@pytest.fixture
def registry(dummy: Capability[object]) -> PluginRegistry:
    return {"dummy": FixedPlugin.bind(name="dummy", capabilities=(dummy,))}


def test_registered_name_resolves(dummy: Capability[object], registry: PluginRegistry) -> None:
    assert (registry["dummy"].from_spec(),) == (dummy,)


def test_a_plugin_with_an_empty_table_adds_nothing(registry: PluginRegistry) -> None:

    displays = build_display_registry(registry)

    assert set(displays.entries) == set(build_display_registry({}).entries)


async def test_generations_adapter_translates_and_reports_bad_parameters() -> None:
    """生成域定义请求约束，适配器负责映射参数与错误。"""

    adapter = GenerationsAdapter(
        cast("GenerationService", object()), FakePrincipals(STUDIO_PRINCIPAL)
    )
    with pytest.raises(InvalidImageRequest, match="aspect_ratio"):
        await adapter.submit(
            STUDIO_PRINCIPAL.user_id,
            ImageRequest(
                prompt="猫",
                model="nano_banana_pro",
                aspect_ratio="17:9",
                resolution="1k",
                channel="dev",
                user_name="logan",
            ),
        )


async def test_generations_adapter_carries_the_conversation_onto_the_job() -> None:

    seen: list[ImageGenerationIn] = []

    class _Recording:
        async def submit_image(
            self, principal: Principal, request: ImageGenerationIn
        ) -> GenerationJob:
            _ = principal
            seen.append(request)
            return make_job(request)

    conversation_id = uuid.uuid4()
    adapter = GenerationsAdapter(
        cast("GenerationService", _Recording()), FakePrincipals(STUDIO_PRINCIPAL)
    )
    await adapter.submit(
        STUDIO_PRINCIPAL.user_id,
        ImageRequest(
            prompt="猫",
            model="nano_banana_pro",
            aspect_ratio="1:1",
            resolution="1k",
            channel="dev",
            user_name="designer-zhang",
            conversation_id=str(conversation_id),
        ),
    )
    assert seen[0].conversation_id == conversation_id
    assert seen[0].user_name == "designer-zhang", "运行替谁跑，图就记在谁头上"


async def test_generations_adapter_turns_intake_rejection_into_a_fixable_error() -> None:
    """受理层按所选模型的能力拒绝时，工具要能让模型改参数，而不是把异常裸抛出去。"""

    class _Rejecting:
        async def submit_image(
            self, principal: Principal, request: ImageGenerationIn
        ) -> GenerationJob:
            _ = principal, request
            raise ValidationFailed("nano_banana_pro 不支持分辨率 8k")

    adapter = GenerationsAdapter(
        cast("GenerationService", _Rejecting()), FakePrincipals(STUDIO_PRINCIPAL)
    )
    with pytest.raises(InvalidImageRequest, match="不支持分辨率 8k"):
        await adapter.submit(
            STUDIO_PRINCIPAL.user_id,
            ImageRequest(
                prompt="猫",
                model="nano_banana_pro",
                aspect_ratio="1:1",
                resolution="1k",
                channel="dev",
                user_name="logan",
            ),
        )


CAT = ImageRequest(
    prompt="猫",
    model="nano_banana_pro",
    aspect_ratio="1:1",
    resolution="1k",
    channel="dev",
    user_name="logan",
)


class _RecordingGenerations:
    """生成域的替身：记下每次收到的主体，查询按受理时的那一行答。"""

    def __init__(self) -> None:
        self.principals: list[Principal] = []
        self._jobs: dict[uuid.UUID, GenerationJob] = {}

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        self.principals.append(principal)
        job = make_job(request)
        self._jobs[job.id] = job
        return job

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        self.principals.append(principal)
        return self._jobs[job_id]


def recording_generations(
    principals: FakePrincipals,
) -> tuple[GenerationsAdapter, _RecordingGenerations]:
    service = _RecordingGenerations()
    adapter = GenerationsAdapter(cast("GenerationService", service), principals)
    return adapter, service


async def test_generations_adapter_rebuilds_the_owner_principal_on_every_call() -> None:
    """端口只收属主 id：每次调用都按它重建一次主体，生成域收到的就是重建出的那一个。"""

    principals = FakePrincipals(STUDIO_PRINCIPAL)
    adapter, service = recording_generations(principals)
    owner = STUDIO_PRINCIPAL.user_id

    job = await adapter.submit(owner, CAT)
    await adapter.get(owner, job.job_id)

    assert principals.asked == [owner, owner]
    assert service.principals == [STUDIO_PRINCIPAL] * 2


async def test_generations_adapter_lets_a_resolver_failure_through() -> None:
    """属主账号不在了：重建主体的错误原样抛出，生成域一次都不调。"""

    adapter, service = recording_generations(FakePrincipals())
    owner = STUDIO_PRINCIPAL.user_id

    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.submit(owner, CAT)
    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.get(owner, uuid.uuid4())
    assert service.principals == []
