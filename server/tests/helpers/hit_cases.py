"""爆款素材库的种数据：对话、出片记录、对话工作区里的新片执行方案，以及直接种进库的条目。

时间戳按「多少分钟以前」给，列表的先后因此可控。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.conversation_same_style import TREATMENT_PATH
from iclip.domains.generation.schemas import VideoGenerationIn, VideoShotIn, request_to_payload

SHOT = VideoShotIn.model_validate(
    {
        "global_settings": "海边木栈道，午后逆光。",
        "timeline": [{"timestamps": [0, 3], "prompt": "模特走向镜头。", "image_indexes": []}],
    }
)

TREATMENT = "# 新片执行方案\n\n白色跑鞋在海边木栈道上的上脚展示，开箱后对比两双鞋的鞋底。"


async def plant_conversation(
    engine: AsyncEngine, owner: uuid.UUID, *, title: str = "凉鞋合集"
) -> uuid.UUID:
    conversation_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
                " updated_at) VALUES (:id, :owner, 'director', :title, now(), now())"
            ),
            {"id": conversation_id, "owner": owner, "title": title},
        )
    return conversation_id


async def plant_job(
    engine: AsyncEngine,
    owner: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    kind: str = "video",
    status: str = "completed",
    finished_minutes_ago: float = 0,
) -> uuid.UUID:
    """一条镜 1 的出片；``kind`` / ``status`` 换掉就不是素材片了。"""

    job_id = uuid.uuid4()
    request = request_to_payload(VideoGenerationIn(model="m", shot=SHOT, user_name="nora"))
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, shot_index, output_url, created_at,"
                " finished_at)"
                " VALUES (:id, :owner, :conversation_id, :kind, 'generate', 'test',"
                " CAST(:request AS jsonb), :status, 1, 'https://oss.example.test/v.mp4', now(),"
                " now() - make_interval(secs => CAST(:ago AS float8) * 60))"
            ),
            {
                "id": job_id,
                "owner": owner,
                "conversation_id": conversation_id,
                "kind": kind,
                "request": json.dumps(request),
                "status": status,
                "ago": finished_minutes_ago,
            },
        )
    return job_id


async def plant_treatment(
    engine: AsyncEngine, owner: uuid.UUID, conversation_id: uuid.UUID, content: str = TREATMENT
) -> None:
    """``owner`` 名下这段对话的工作区里放一份新片执行方案。"""

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.workspace_files"
                " (namespace, path, content, version, created_at, updated_at)"
                " VALUES (:ns, :path, :content, 1, now(), now())"
            ),
            {"ns": f"{owner}/{conversation_id}", "path": TREATMENT_PATH, "content": content},
        )


async def plant_material(
    engine: AsyncEngine, owner: uuid.UUID, *, finished_minutes_ago: float = 0
) -> tuple[uuid.UUID, uuid.UUID]:
    """能入选的一条：对话、对话里的出片与新片执行方案都齐；返回（对话 id，出片 id）。"""

    conversation_id = await plant_conversation(engine, owner)
    job_id = await plant_job(
        engine, owner, conversation_id, finished_minutes_ago=finished_minutes_ago
    )
    await plant_treatment(engine, owner, conversation_id)
    return conversation_id, job_id


async def plant_hit_case(
    engine: AsyncEngine,
    job_id: uuid.UUID,
    *,
    tags: Sequence[uuid.UUID] = (),
    status: str | None = "completed",
    added_minutes_ago: float = 0,
) -> uuid.UUID:
    """不走接口，直接把一条放进爆款素材库，带这些标签。"""

    entry_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.library_entries (id, kind, job_id, tag_status, created_at)"
                " VALUES (:id, 'hit_case', :job_id, :status,"
                " now() - make_interval(secs => CAST(:ago AS float8) * 60))"
            ),
            {"id": entry_id, "job_id": job_id, "status": status, "ago": added_minutes_ago},
        )
        for one in tags:
            await conn.execute(
                text("INSERT INTO iclip.library_entry_tags (entry_id, tag_id) VALUES (:e, :t)"),
                {"e": entry_id, "t": one},
            )
    return entry_id


async def hit_case_rows(engine: AsyncEngine, job_id: uuid.UUID) -> tuple[int, int]:
    """这条素材片在库里的（条目数，标签数）。"""

    async with engine.connect() as conn:
        entries = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM iclip.library_entries"
                    " WHERE kind = 'hit_case' AND job_id = :id"
                ),
                {"id": job_id},
            )
        ).scalar_one()
        tags = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM iclip.library_entry_tags et"
                    " JOIN iclip.library_entries e ON e.id = et.entry_id"
                    " WHERE e.kind = 'hit_case' AND e.job_id = :id"
                ),
                {"id": job_id},
            )
        ).scalar_one()
    return int(entries), int(tags)


__all__ = [
    "TREATMENT",
    "hit_case_rows",
    "plant_conversation",
    "plant_hit_case",
    "plant_job",
    "plant_material",
    "plant_treatment",
]
