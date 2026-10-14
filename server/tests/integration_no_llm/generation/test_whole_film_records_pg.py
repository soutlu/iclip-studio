"""整片落在生成记录表里：请求往返、组合约束（迁移 0027），以及它在成片、在途与下载口径里的位置。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.schemas import (
    VideoComposeRequest,
    WholeFilmRequest,
    request_to_payload,
)
from iclip.domains.tracking.infra_sql import SqlTrackingRepository
from tests.helpers.fork_lineage import make_user
from tests.helpers.generation import (
    make_composite,
    make_edit,
    make_job,
    make_whole_film,
    video_request,
    whole_film_request,
)

TAKE_URL = "https://cdn.example.test/take.mp4"
FILM_URL = "https://cdn.example.test/iclip/agent/video-masters/film.mp4"


async def test_a_whole_film_round_trips_its_timeline_and_counts_as_a_master(
    engine: AsyncEngine,
) -> None:
    """读回来还是整片的请求，同表里合成的请求也还是合成的；在途时算对话的视频在跑，完成了是这段对话
    最新的成片，也能被下载。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    conversation = uuid.uuid4()
    take = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=conversation)
    )
    await repo.mark_completed(
        take.id, output_url=TAKE_URL, watermark_output_url=TAKE_URL, provider_status="ok"
    )
    edit = await repo.create(make_edit(take, owner_user_id=owner, conversation_id=conversation))
    composite = await repo.create(
        make_composite(edit, owner_user_id=owner, conversation_id=conversation)
    )
    film = await repo.create(
        make_whole_film(take, owner_user_id=owner, conversation_id=conversation)
    )

    assert isinstance((await repo.get(film.id, owner=owner)).request, WholeFilmRequest)
    assert (await repo.get(film.id, owner=owner)).request == film.request
    assert isinstance((await repo.get(composite.id, owner=owner)).request, VideoComposeRequest)
    assert await repo.in_flight_by_conversation([conversation], kind="video") == {
        conversation: "queued"
    }

    await repo.mark_submitting(film.id)
    done = await repo.mark_completed(
        film.id, output_url=FILM_URL, provider_status="completed", duration_ms=1000
    )

    assert done is not None and done.status == STATUS_COMPLETED
    assert (done.source_job_id, done.root_job_id, done.shot_index) == (None, None, None)
    assert await repo.latest_master_by_conversation([conversation]) == {conversation: FILM_URL}
    assert await SqlTrackingRepository(engine).downloadable(film.id), "整片是成片，能下载"


_FILM_ROW: dict[str, Any] = {
    "conversation": True,
    "source": False,
    "root": False,
    "shot_index": None,
    "range": None,
}
"""一条合法的排队中整片；各用例在它上面改几列，``source`` / ``root`` 为真就指一条现成的出片。"""

_REFUSED: dict[str, dict[str, Any]] = {
    "没挂对话": {"conversation": False},
    "带镜号": {"shot_index": 1},
    "带区间": {"range": (0, 1000)},
    "只有原作": {"root": True},
    "只有来源": {"source": True},
}

_ACCEPTED: dict[str, dict[str, Any]] = {
    "整片": {},
    "合成照旧": {"source": True, "root": True, "shot_index": 1},
}


async def _insert(engine: AsyncEngine, shape: Mapping[str, Any]) -> None:
    """绕过受理层直接写一行 video / compose。"""

    repo = SqlGenerationRepository(engine)
    owner = await make_user(engine)
    take = await repo.create(make_job(video_request(), owner_user_id=owner))
    row = {**_FILM_ROW, **shape}
    span = row["range"]
    request = whole_film_request([{"url": TAKE_URL, "startMs": 0, "endMs": 1000}])
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                " operation, provider, request, status, source_job_id, root_job_id, shot_index,"
                " range_start_ms, range_end_ms, created_at)"
                " VALUES (:id, :owner, :conversation, 'video', 'compose', 'ffmpeg',"
                " CAST(:request AS jsonb), 'pending', :source, :root, :shot_index, :start, :end,"
                " now())"
            ),
            {
                "id": uuid.uuid4(),
                "owner": owner,
                "conversation": uuid.uuid4() if row["conversation"] else None,
                "request": json.dumps(request_to_payload(request)),
                "source": take.id if row["source"] else None,
                "root": take.id if row["root"] else None,
                "shot_index": row["shot_index"],
                "start": None if span is None else span[0],
                "end": None if span is None else span[1],
            },
        )


@pytest.mark.parametrize("shape", list(_REFUSED))
async def test_compose_rows_of_no_known_shape_are_refused(engine: AsyncEngine, shape: str) -> None:
    with pytest.raises(IntegrityError):
        await _insert(engine, _REFUSED[shape])


@pytest.mark.parametrize("shape", list(_ACCEPTED))
async def test_compose_rows_of_a_known_shape_are_accepted(engine: AsyncEngine, shape: str) -> None:
    await _insert(engine, _ACCEPTED[shape])
