"""发消息的附件转存：只转挂不上 OSS 参数的图片，同址只转一次、并发转，id 可复算，失败说第几张。"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field

import pytest
from agent_runtime.errors import ValidationFailed
from agent_runtime.transcript.ops import (
    AttachmentSource,
    ImageContent,
    PromptContent,
    TextContent,
    VideoContent,
)

from iclip.app.prompt_attachments import PromptAttachmentImporter
from iclip.domains.identity.models import Principal
from iclip.platform.object_store.store import ObjectStoreUnavailable

pytestmark = pytest.mark.unit

OSS = "https://bkt.oss-ap-southeast-1.aliyuncs.com/iclip/agent/uploads/kept.png"
EXTERNAL = "https://img.example.com/look.jpg"
SIGNED = "https://bkt.oss-ap-southeast-1.aliyuncs.com/a.png?Signature=abc"
VIDEO = "https://cdn.example.com/ref.mp4"
CONVERSATION = "0b7e7c1e-9c55-4f3f-9a43-1d1c2b3a4d5e"
ME = Principal(
    kind="user",
    user_id=uuid.UUID("11111111-2222-3333-4444-555555555555"),
    permissions=frozenset({"agent:run"}),
    audit_label="tester",
)


def image(url: str) -> ImageContent:
    return ImageContent(source=AttachmentSource(kind="url", url=url))


def video(url: str) -> VideoContent:
    return VideoContent(source=AttachmentSource(kind="url", url=url))


def stored_url(upload_id: uuid.UUID) -> str:
    return f"https://bkt.oss-ap-southeast-1.aliyuncs.com/iclip/agent/uploads/{upload_id}.png"


@dataclass
class FakeImport:
    """uploads 转存的替身：记下每次转存，按地址注入失败；量一下同时在转几张。"""

    failures: dict[str, Exception] = field(default_factory=dict[str, Exception])
    calls: list[tuple[Principal, str, uuid.UUID]] = field(
        default_factory=list[tuple[Principal, str, uuid.UUID]]
    )
    in_flight: int = 0
    peak: int = 0

    async def __call__(self, principal: Principal, url: str, *, upload_id: uuid.UUID) -> str:
        self.calls.append((principal, url, upload_id))
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await asyncio.sleep(0.01)
            if url in self.failures:
                raise self.failures[url]
            return stored_url(upload_id)
        finally:
            self.in_flight -= 1


async def run(
    fake: FakeImport, content: tuple[PromptContent, ...], *, prompt_id: str | None = "prm_1"
) -> tuple[PromptContent, ...]:
    return await PromptAttachmentImporter(fake)(
        ME, conversation_id=CONVERSATION, prompt_id=prompt_id, content=content
    )


async def test_only_images_that_cannot_carry_oss_parameters_are_replaced() -> None:
    fake = FakeImport()
    content = (
        TextContent(text="照这两张"),
        image(EXTERNAL),
        image(OSS),
        image(SIGNED),
        video(VIDEO),
        image(EXTERNAL),
    )

    replaced = await run(fake, content)

    ids = {url: upload_id for _, url, upload_id in fake.calls}
    assert sorted(ids) == sorted([EXTERNAL, SIGNED]), "同一个地址只转一次，OSS 地址与视频不转"
    assert fake.peak == 2, "同一条消息里的几张并发转"
    assert replaced == (
        TextContent(text="照这两张"),
        image(stored_url(ids[EXTERNAL])),
        image(OSS),
        image(stored_url(ids[SIGNED])),
        video(VIDEO),
        image(stored_url(ids[EXTERNAL])),
    )


async def test_without_a_prompt_id_every_call_gets_a_fresh_upload_id() -> None:
    first, again = FakeImport(), FakeImport()
    await run(first, (image(EXTERNAL),), prompt_id=None)
    await run(again, (image(EXTERNAL),), prompt_id=None)

    assert first.calls[0][2] != again.calls[0][2]


async def test_nothing_to_import_leaves_the_content_alone() -> None:
    fake = FakeImport()
    content = (TextContent(text="走"), image(OSS), video(VIDEO), image("file:///etc/passwd"))

    assert await run(fake, content) is content
    assert fake.calls == []


async def test_a_failed_image_names_its_attachment_position_and_the_rest_still_land() -> None:
    """附件从 1 数、视频也算；同时在转的那张照样转完，重发同一条消息时复用。"""

    bad = "https://img.example.com/broken.jpg"
    fake = FakeImport(failures={bad: ValidationFailed("这张图下载不下来：对方回了 404")})
    content = (TextContent(text="看"), video(VIDEO), image(EXTERNAL), image(bad))

    with pytest.raises(ValidationFailed, match="第 3 张附件转存不了：这张图下载不下来"):
        await run(fake, content)

    assert sorted(url for _, url, _ in fake.calls) == sorted([EXTERNAL, bad])
    assert fake.in_flight == 0


async def test_an_object_store_failure_is_not_turned_into_a_validation_error() -> None:
    fake = FakeImport(failures={EXTERNAL: ObjectStoreUnavailable("OSS 写入失败")})

    with pytest.raises(ObjectStoreUnavailable):
        await run(fake, (image(EXTERNAL),))
