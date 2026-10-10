"""参考视频的测试替身：方舟接口的协议替身、抽帧替身、种用户与种行。

拆解与打标走真的适配器（``ArkVideoBreakdowns`` / ``ArkTagger``），只把 HTTP 与 ffmpeg 换成替身，
失败原因的映射与打标的解析因此照生产路径走。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.reference_breakdown import ArkTagger, ArkVideoBreakdowns
from iclip.app.reference_test_video import TEST_VIDEO_MODEL
from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.ports import SampledVideo
from iclip.config import RuntimeConfig, VideoGenerationSection
from iclip.config.models import IclipStudioSection
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import TestVideoJob
from iclip.domains.references.test_prompt import TestPrompt
from iclip.platform.media.ffmpeg import MediaError
from tests.helpers.app import make_runtime_config
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media

STUDIO_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-ap-southeast-1.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
    "VIDEO_UNDERSTANDING_URL": "https://ark.test/responses",
    "VIDEO_UNDERSTANDING_API_KEY": "ark",
}
"""拆解配好、媒体生成没开要的环境变量；地址都是替身，装配期不外呼。"""


def config_with_studio() -> RuntimeConfig:
    """测试运行配置外加 ``iclip_studio`` 段，不带媒体生成段。"""

    return make_runtime_config().model_copy(
        update={"iclip_studio": IclipStudioSection(breakdown_model="seed-vision")}
    )


STUDIO_MEDIA_ENVS = STUDIO_ENVS | MEDIA_ENVS
"""拆解配好、媒体生成也开着要的环境变量。"""


def config_with_studio_and_media() -> RuntimeConfig:
    """拆解配好、媒体生成也开着：视频允许表里有试生成用的模型。"""

    media = config_with_media()
    assert media.media_generation is not None
    video = VideoGenerationSection(model="seedance", allowed_models=("seedance", TEST_VIDEO_MODEL))
    return media.model_copy(
        update={
            "iclip_studio": IclipStudioSection(breakdown_model="seed-vision"),
            "media_generation": media.media_generation.model_copy(update={"video": video}),
        }
    )


class NoTestVideos:
    """没有试生成过；提交不该被调到。"""

    async def latest(self, owner: uuid.UUID, reference_id: uuid.UUID) -> TestVideoJob | None:
        return None

    async def submit(
        self, principal: Principal, reference_id: uuid.UUID, prompt: TestPrompt, aspect_ratio: str
    ) -> None:
        raise AssertionError("这里不该提交试生成")


async def upload_video(client: httpx.AsyncClient, bucket: MemoryObjectStore) -> str:
    """走一遍直传：签名、把字节放进桶、确认；返回 ``uploadId``。"""

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
"""替身对一次请求的回答：一个响应，或要抛出的传输层异常。"""


def responses_body(text_out: str, *, status: str = "completed") -> dict[str, Any]:
    """方舟 Responses 的响应体：一段思考加一条正文。"""

    return {
        "status": status,
        "output": [
            {"type": "reasoning", "content": []},
            {"type": "message", "content": [{"type": "output_text", "text": text_out}]},
        ],
    }


def tag_answer(
    video_types: Sequence[str] = ("review",), categories: Sequence[str] = ("跑鞋",)
) -> httpx.Response:
    return httpx.Response(
        200,
        json=responses_body(
            json.dumps({"videoTypes": list(video_types), "categories": list(categories)})
        ),
    )


def breakdown_answer(document: str = DOCUMENT) -> httpx.Response:
    return httpx.Response(200, json=responses_body(document))


class FakeArk:
    """方舟接口替身：带 ``text.format`` 的请求是打标，其余是拆解；各自按给定的回答答。"""

    def __init__(self, *, breakdown: Answer | None = None, tag: Answer | None = None) -> None:
        self.breakdown: Answer = breakdown if breakdown is not None else breakdown_answer()
        self.tag: Answer = tag if tag is not None else tag_answer()
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
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
    """5 秒的短片，抽出一帧；``broken`` 时取视频就失败。"""

    def __init__(self, *, broken: bool = False) -> None:
        self.broken = broken

    async def duration_seconds(self, video_url: str) -> float:
        if self.broken:
            raise MediaError("取不到这条视频")
        return 5.0

    async def sample(self, video_url: str) -> SampledVideo:
        return SampledVideo(frames=(b"jpeg",), audio=None)


def ark_pipeline(
    ark: FakeArk, *, sampler: FakeSampler | None = None
) -> tuple[ArkVideoBreakdowns, ArkTagger]:
    """真的拆解与打标适配器，HTTP 与抽帧都是替身。"""

    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=httpx.MockTransport(ark)),
        url="https://ark.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    breakdown = VideoBreakdown(model=model, sampler=sampler or FakeSampler())
    return ArkVideoBreakdowns(breakdown), ArkTagger(model)


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
    video_types: Sequence[str] = (),
    categories: Sequence[str] = (),
    error_code: str | None = None,
    started_minutes_ago: float | None = None,
    created_minutes_ago: float = 0,
) -> uuid.UUID:
    """直接种一行；``started_minutes_ago`` 给了就把开始时刻放到那么久以前。"""

    reference_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.reference_videos (id, video_url, owner_user_id, video_types,"
                " categories, breakdown_status, error_code, document, started_at, created_at)"
                " VALUES (:id, :url, :owner, CAST(:types AS text[]), CAST(:cats AS text[]),"
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
                "types": list(video_types),
                "cats": list(categories),
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
    "plant_reference",
    "plant_user",
    "reference_row",
    "responses_body",
    "tag_answer",
    "upload_video",
]
