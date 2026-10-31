"""发消息入口的图片转存：挂不上 OSS 处理参数的图片受理前转存进本桶，素材台账与队列存新地址；
转存失败整条 422、什么都不写；没配对象存储时这种图片直接 422。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import FastAPI
from PIL import Image
from pydantic_ai.models import Model
from sqlalchemy import text

from iclip.platform.db.engine import build_engine
from iclip.platform.outbound.guard import FetchFailed
from tests.helpers.agents import AgentSeed, model_builder, seed_agents
from tests.helpers.app import make_client, make_runtime_config, new_conversation, settled
from tests.helpers.auth import login_as_editor
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected, reset_database
from tests.helpers.runtime_backed import build_backed_app, config_services_of

AGENT_ID = "storyboard"
BUCKET_BASE = "https://iclip-test.oss-ap-southeast-1.aliyuncs.com"
OSS_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-ap-southeast-1.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": BUCKET_BASE,
}
EXTERNAL = "https://img.example.com/look.jpg?token=abc"
ALREADY_OURS = f"{BUCKET_BASE}/iclip/agent/uploads/{uuid.uuid4()}.png"


def picture() -> bytes:
    out = BytesIO()
    Image.new("RGB", (1200, 1600), "white").save(out, format="PNG")
    return out.getvalue()


@dataclass
class CountingFetch:
    """出网下载替身：数下载了几次，``error`` 给了就抛它。"""

    body: bytes = field(default_factory=picture)
    error: Exception | None = None
    calls: list[str] = field(default_factory=list[str])

    async def __call__(self, url: str, *, max_bytes: int) -> bytes:
        self.calls.append(url)
        if self.error is not None:
            raise self.error
        return self.body


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID),)


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore(base=BUCKET_BASE)


@pytest.fixture
def fetch() -> CountingFetch:
    return CountingFetch()


@pytest.fixture
async def oss_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    agent_seeds: tuple[AgentSeed, ...],
    models: Mapping[str, Model],
    bucket: MemoryObjectStore,
    fetch: CountingFetch,
    tmp_path: Path,
) -> AsyncGenerator[FastAPI]:
    """配了对象存储的 app：桶与出网下载都是替身。"""

    for name, value in OSS_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = build_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    try:
        built = build_backed_app(
            make_runtime_config(skill_cache_dir=tmp_path / "skills"),
            engine=engine,
            build_model=model_builder(models),
            credential_probe=KeyCheckingProbe({GOOD_KEY}),
            object_store=bucket,
            image_fetcher=fetch,
        )
        await seed_agents(config_services_of(built), engine, agent_seeds)
        yield built
    finally:
        await engine.dispose()


def image(url: str) -> dict[str, object]:
    return {"type": "image", "source": {"kind": "url", "url": url}}


async def materials(pg_url: str, namespace: str) -> list[str]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text("SELECT url FROM agent_runtime.materials WHERE namespace = :ns ORDER BY url"),
            {"ns": namespace},
        )
        return [row[0] for row in rows]


async def queued_image_urls(pg_url: str, conversation_id: str) -> list[list[str]]:
    """队列里每条消息的图片地址，按提交先后。"""

    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT content FROM agent_runtime.agent_jobs "
                "WHERE conversation_id = :cid ORDER BY created_at"
            ),
            {"cid": conversation_id},
        )
        return [
            [part["source"]["url"] for part in json.loads(row[0]) if part["type"] == "image"]
            for row in rows
        ]


async def image_uploads(pg_url: str) -> list[tuple[uuid.UUID, str]]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT owner_user_id, output ->> 'url' FROM iclip.generation_jobs "
                "WHERE operation = 'upload' AND kind = 'image'"
            )
        )
        return [(row[0], row[1]) for row in rows]


async def test_an_external_image_is_imported_and_only_the_new_address_is_kept(
    oss_app: FastAPI, pg_url: str, bucket: MemoryObjectStore, fetch: CountingFetch
) -> None:
    async with make_client(oss_app) as client:
        user_id = await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={
                "prompt_id": "prm_import",
                "content": [{"type": "text", "text": "照这张"}, image(EXTERNAL)],
            },
        )
        assert sent.status_code == 200, sent.text
        await settled(client, conversation_id)

    assert fetch.calls == [EXTERNAL]
    (stored,) = [key for key in bucket.objects if key.startswith("iclip/agent/uploads/")]
    new_url = f"{BUCKET_BASE}/{stored}"
    assert stored.endswith(".png")
    assert sent.json()["content"][1]["source"]["url"] == new_url
    assert await materials(pg_url, f"{user_id}/{conversation_id}") == [new_url]
    assert await queued_image_urls(pg_url, conversation_id) == [[new_url]]
    assert await image_uploads(pg_url) == [(uuid.UUID(user_id), new_url)]
    assert bucket.metadata[stored] == {"x-oss-meta-uploader": user_id}


async def test_an_address_that_can_carry_oss_parameters_passes_through_untouched(
    oss_app: FastAPI, pg_url: str, fetch: CountingFetch
) -> None:
    async with make_client(oss_app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_ours", "content": [image(ALREADY_OURS)]},
        )
        assert sent.status_code == 200, sent.text
        await settled(client, conversation_id)

    assert fetch.calls == []
    assert await queued_image_urls(pg_url, conversation_id) == [[ALREADY_OURS]]
    assert await image_uploads(pg_url) == []


async def test_resending_the_same_prompt_id_downloads_nothing(
    oss_app: FastAPI, pg_url: str, fetch: CountingFetch
) -> None:
    body = {"prompt_id": "prm_twice", "content": [image(EXTERNAL)]}
    async with make_client(oss_app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        first = await client.post(f"/conversations/{conversation_id}/prompts", json=body)
        assert first.status_code == 200, first.text
        fetch.calls.clear()
        again = await client.post(f"/conversations/{conversation_id}/prompts", json=body)
        assert again.status_code == 200, again.text
        await settled(client, conversation_id)

    assert fetch.calls == []
    assert again.json()["content"] == first.json()["content"]
    assert len(await image_uploads(pg_url)) == 1


async def test_a_failed_import_is_422_and_nothing_is_written(
    oss_app: FastAPI, pg_url: str, fetch: CountingFetch
) -> None:
    fetch.error = FetchFailed("对方回了 404")
    async with make_client(oss_app) as client:
        user_id = await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={
                "prompt_id": "prm_broken",
                "content": [image(ALREADY_OURS), image(EXTERNAL)],
            },
        )

    assert sent.status_code == 422, sent.text
    assert "第 2 张附件" in sent.json()["detail"]
    assert await materials(pg_url, f"{user_id}/{conversation_id}") == []
    assert await queued_image_urls(pg_url, conversation_id) == []


async def test_regenerating_with_new_content_imports_its_images(
    oss_app: FastAPI, pg_url: str, bucket: MemoryObjectStore, fetch: CountingFetch
) -> None:
    async with make_client(oss_app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_first", "content": [{"type": "text", "text": "先问"}]},
        )
        assert sent.status_code == 200, sent.text
        await settled(client, conversation_id)

        edited = await client.post(
            f"/conversations/{conversation_id}/turns/t1:regenerate",
            json={"prompt_id": "prm_edit", "content": [image(EXTERNAL)]},
        )
        assert edited.status_code == 200, edited.text
        await settled(client, conversation_id)

    assert fetch.calls == [EXTERNAL]
    (stored,) = [key for key in bucket.objects if key.startswith("iclip/agent/uploads/")]
    new_url = f"{BUCKET_BASE}/{stored}"
    (part,) = edited.json()["content"]
    assert (part["type"], part["source"]["url"]) == ("image", new_url)
    assert await queued_image_urls(pg_url, conversation_id) == [[], [new_url]]


async def test_without_an_object_store_an_external_image_is_refused(
    app: FastAPI, pg_url: str
) -> None:
    """没配对象存储就转存不了：挂不上处理参数的图片在受理时 422，台账与队列都不写。"""

    async with make_client(app) as client:
        user_id = await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        sent = await client.post(
            f"/conversations/{conversation_id}/prompts",
            json={"prompt_id": "prm_no_bucket", "content": [image(EXTERNAL)]},
        )

    assert sent.status_code == 422, sent.text
    assert "OSS" in sent.json()["detail"]
    assert await materials(pg_url, f"{user_id}/{conversation_id}") == []
    assert await queued_image_urls(pg_url, conversation_id) == []
