from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, TypedDict

import httpx
from cue.client import RuntimeClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.library_tagging import ArkTagger, build_library_tagger
from iclip.app.reference_breakdown import ArkVideoBreakdowns
from iclip.app.reference_test_video import TEST_VIDEO_MODEL
from iclip.config import RuntimeConfig, VideoGenerationSection
from iclip.config.models import IclipStudioSection
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import TestVideoJob
from iclip.domains.references.test_prompt import TestPrompt
from iclip.platform.media.errors import MediaError
from iclip.platform.video_breakdown.model import BREAKDOWN_MODEL, ArkBreakdownModel
from iclip.platform.video_breakdown.ports import SampledVideo
from iclip.platform.video_breakdown.service import BreakdownRunner
from tests.helpers.app import make_runtime_config
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media

STUDIO_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-ap-southeast-1.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
}


def config_with_studio() -> RuntimeConfig:
    return make_runtime_config().model_copy(update={"iclip_studio": IclipStudioSection()})


STUDIO_MEDIA_ENVS = STUDIO_ENVS | MEDIA_ENVS


def config_with_studio_and_media() -> RuntimeConfig:
    media = config_with_media()
    assert media.media_generation is not None
    video = VideoGenerationSection(model="seedance", allowed_models=("seedance", TEST_VIDEO_MODEL))
    return media.model_copy(
        update={
            "iclip_studio": IclipStudioSection(),
            "media_generation": media.media_generation.model_copy(update={"video": video}),
        }
    )


class NoTestVideos:
    async def latest(self, owner: uuid.UUID, reference_id: uuid.UUID) -> TestVideoJob | None:
        return None

    async def submit(
        self,
        principal: Principal,
        reference_id: uuid.UUID,
        prompt: TestPrompt,
        aspect_ratio: str,
        *,
        user_name: str,
    ) -> None:
        raise AssertionError("这里不该提交试生成")


async def upload_video(client: httpx.AsyncClient, bucket: MemoryObjectStore) -> str:
    signed = await client.post("/uploads/sign", json={"contentType": "video/mp4"})
    assert signed.status_code == 200, signed.text
    upload_id = signed.json()["uploadId"]
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{upload_id}.mp4",
        content=b"x" * 10,
        content_type="video/mp4",
    )
    confirmed = await client.post(f"/uploads/{upload_id}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return str(upload_id)


VIDEO = "https://cdn.example.test/iclip/agent/uploads/ref.mp4"
DOCUMENT = "# 出场元素\n\n| 类型 | 名字 | 辨识特征 | 首次出现 |\n| 产品 | 白色跑鞋 | 网面 | 0.0 |"

Answer = httpx.Response | Exception


def responses_body(text_out: str, *, status: str = "completed") -> dict[str, Any]:
    return {
        "status": status,
        "output": [
            {"type": "reasoning", "content": []},
            {"type": "message", "content": [{"type": "output_text", "text": text_out}]},
        ],
    }


class TagCategorySelection(TypedDict):
    category: str
    subcategories: Sequence[TagSelection]


type TagSelection = str | TagCategorySelection


DEFAULT_TAGS: Mapping[str, Sequence[TagSelection]] = {
    "d1": ("跑鞋",),
    "d2": (),
    "d3": ({"category": "开箱测评型", "subcategories": ("对比测评",)},),
}


def tag_answer(answer: Mapping[str, Sequence[TagSelection]] = DEFAULT_TAGS) -> httpx.Response:
    return httpx.Response(
        200,
        json=responses_body(json.dumps({key: list(values) for key, values in answer.items()})),
    )


def breakdown_answer(document: str = DOCUMENT) -> httpx.Response:
    return httpx.Response(200, json=responses_body(document))


def model_unavailable() -> httpx.Response:
    return httpx.Response(
        409,
        json={
            "detail": "配置页的火山方舟里没有启用的模型 doubao-seed-2-1-lite-260915（或没有默认密钥）",
            "code": "model_unavailable",
        },
    )


class FakeArk:
    def __init__(self, *, breakdown: Answer | None = None, tag: Answer | None = None) -> None:
        self.breakdown: Answer = breakdown if breakdown is not None else breakdown_answer()
        self.tag: Answer = tag if tag is not None else tag_answer()
        self.requests: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/model-calls/responses"
        call = json.loads(request.content)
        call["read_timeout"] = request.extensions["timeout"]["read"]
        self.calls.append(call)
        payload = call["payload"]
        self.requests.append(payload)
        answer = self.tag if "text" in payload else self.breakdown
        if isinstance(answer, Exception):
            raise answer
        return answer

    @property
    def breakdown_calls(self) -> int:
        return sum(1 for one in self.requests if "text" not in one)

    @property
    def tag_requests(self) -> list[dict[str, Any]]:
        return [one for one in self.requests if "text" in one]


class FakeSampler:
    def __init__(self, *, broken: bool = False) -> None:
        self.broken = broken

    async def sample_up_to(self, video_url: str, *, max_seconds: float) -> SampledVideo | None:
        if self.broken:
            raise MediaError("取不到这条视频")
        return SampledVideo(frames=(b"jpeg",), audio=None)


def ark_pipeline(
    ark: FakeArk, *, sampler: FakeSampler | None = None
) -> tuple[ArkVideoBreakdowns, ArkTagger]:
    runtime = RuntimeClient(
        "http://runtime.test", "app-key-test-0123456789", transport=httpx.MockTransport(ark)
    )
    breakdown = BreakdownRunner(
        model=ArkBreakdownModel(runtime, model=BREAKDOWN_MODEL), sampler=sampler or FakeSampler()
    )
    return ArkVideoBreakdowns(breakdown), build_library_tagger(runtime)


async def plant_user(engine: AsyncEngine, name: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.users (id, username, email, hashed_password, is_active,"
                " is_superuser, is_verified, display_name, avatar_url, roles,"
                " direct_permissions, city, job_title, departments)"
                " VALUES (:id, :name, :email, 'x', true, false, true, :name, '',"
                " '[\"editor\"]'::jsonb, '[]'::jsonb, '', '', '[]'::jsonb)"
            ),
            {"id": user_id, "name": name, "email": f"{name}@example.test"},
        )
    return user_id


async def plant_reference(
    engine: AsyncEngine,
    *,
    owner: uuid.UUID,
    video_url: str = VIDEO,
    status: str = "completed",
    document: str | None = DOCUMENT,
    error_code: str | None = None,
    started_minutes_ago: float | None = None,
    created_minutes_ago: float = 0,
) -> uuid.UUID:
    reference_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.reference_videos (id, video_url, owner_user_id,"
                " breakdown_status, error_code, document, started_at, created_at)"
                " VALUES (:id, :url, :owner,"
                " :status, :error_code, :document,"
                " CASE WHEN CAST(:started AS float8) IS NULL THEN NULL"
                "      ELSE now() - make_interval(secs => CAST(:started AS float8) * 60)"
                " END,"
                " now() - make_interval(secs => CAST(:created AS float8) * 60))"
            ),
            {
                "id": reference_id,
                "url": video_url,
                "owner": owner,
                "status": status,
                "error_code": error_code,
                "document": document,
                "started": started_minutes_ago,
                "created": created_minutes_ago,
            },
        )
    return reference_id


async def reference_row(engine: AsyncEngine, reference_id: uuid.UUID) -> dict[str, Any]:
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT * FROM iclip.reference_videos WHERE id = :id"),
                    {"id": reference_id},
                )
            )
            .mappings()
            .one()
        )
    return dict(row)


__all__ = [
    "DEFAULT_TAGS",
    "DOCUMENT",
    "STUDIO_ENVS",
    "STUDIO_MEDIA_ENVS",
    "VIDEO",
    "FakeArk",
    "FakeSampler",
    "NoTestVideos",
    "ark_pipeline",
    "breakdown_answer",
    "config_with_studio",
    "config_with_studio_and_media",
    "model_unavailable",
    "plant_reference",
    "plant_user",
    "reference_row",
    "responses_body",
    "tag_answer",
    "upload_video",
]
