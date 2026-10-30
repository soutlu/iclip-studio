"""资料库的 Postgres 查询：一段对话一张卡，核卡的归属、卡面、镜头组、血缘、筛选与翻页。

主体数据用原生 SQL 直插，时间戳自己定（业务仓储都用数据库时钟，控不住时刻）；与生成仓储对照的
那条用例用分叉场景构造器，走数据库时钟。"""

from __future__ import annotations

import json
import uuid
from collections import Counter
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from iclip_video.shot_prompt import ShotCut, ShotScript, format_shot_prompt
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_FAILED, STATUS_SUBMITTED
from iclip.domains.generation.render import PROVIDER_NAME as RENDER_PROVIDER
from iclip.domains.generation.schemas import (
    KIND_AUDIO,
    KIND_SUBTITLE,
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_COMPOSE,
    OPERATION_ENHANCE,
    OPERATION_GENERATE,
    OPERATION_RENDER,
    OPERATION_UPLOAD,
    VideoEnhanceRequest,
    request_to_payload,
)
from iclip.domains.library.models import Scope, VideoCursor, WholeFilmScope
from iclip.domains.library.reports_pg import PgLibraryReports
from iclip.domains.library.schemas import ShotGroupOut
from tests.helpers.fork_lineage import three_level_fork
from tests.helpers.generation import whole_film_request

BASE = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
NORA = "Nora.Ho"
LENA = "Lena.Song"
SARA = "Sara.Hong"
"""只出现在请求的 ``user_name`` 里、没有账号的名字：资料库的作者一律按属主，不认它。"""

SHOT_ONE: dict[str, Any] = {
    "global_settings": "浅灰地面与白墙，干净留白。",
    "timeline": [
        {"timestamps": [0, 3], "prompt": "空地面停一拍。", "image_indexes": []},
        {"timestamps": [3, 7], "prompt": "踩入 @Image1 夹趾凉鞋。", "image_indexes": [1]},
    ],
}
SHOT_ONE_PROMPT = format_shot_prompt(
    ShotScript(
        global_settings=SHOT_ONE["global_settings"],
        timeline=tuple(
            ShotCut(
                timestamps=(cut["timestamps"][0], cut["timestamps"][1]),
                prompt=cut["prompt"],
                image_indexes=tuple(cut["image_indexes"]),
            )
            for cut in SHOT_ONE["timeline"]
        ),
    )
)
"""受理时服务端照 shot 拼出、与 shot 一起存进请求的正文。"""
SHOT_ONE_CUTS = ["空地面停一拍。", "踩入 @Image1 夹趾凉鞋。"]
MARKER_PROMPT = (
    "浅灰地面与白墙。\n\n[0–4秒｜镜头1] 换成编织凉鞋 @Image1。\n[4–8秒｜镜头2] 向前迈一步。\n"
    "不要生成字幕，不要生成背景音乐。"
)


def at(minutes: float) -> datetime:
    return BASE + timedelta(minutes=minutes)


def url(name: str) -> str:
    return f"https://oss.example.test/{name}.mp4"


def shape(groups: Sequence[ShotGroupOut]) -> list[tuple[int | None, list[uuid.UUID]]]:
    return [(group.shot_index, [version.job_id for version in group.versions]) for group in groups]


class Seed:
    """两个人、四段对话、三条不挂对话的出片。时刻是距 BASE 的分钟数，写作「建立 → 完成」。

    c1 Nora「春夏凉鞋合集」（-60 建）：镜 1 A（结构化 shot，0 → 5）、B（拼好的正文，60 → 65）、
    A 上的合成 M（90 → 92）；镜 2 C 失败、D（30 → 50）、D2（40 → 45，晚建早完成）；没镜号的
    P（10 → 12）与它上面的合成 PC（79 → 80）、Q（11 → 13）。
    c2 Lena「滑板街拍」（-60 建）：E（40 → 130）与它上面的编辑段（131 → 132）。
    c4 Lena 分叉自 c1（50 建，D 的完成时刻正好等于边界）：在继承来的 A 上剪出合成 Y（100 → 101），
    自己出 G（110 → 120）。c5 Lena 分叉自 c1（70 建），没有自己的行。
    不挂对话：Nora 的横版纯文本 H（10 → 14）与它上面的合成 HC（40 → 42），Lena 的 K（15 → 16）。
    H、HC、Y 的请求里写的是 SARA。
    """

    def __init__(self) -> None:
        self.nora, self.lena = uuid.uuid4(), uuid.uuid4()
        self.c1, self.c2, self.c4, self.c5 = (uuid.uuid4() for _ in range(4))
        self.a, self.b, self.m, self.c, self.d, self.d2 = (uuid.uuid4() for _ in range(6))
        self.p, self.pc, self.q, self.e, self.e_edit = (uuid.uuid4() for _ in range(5))
        self.y, self.g, self.h, self.hc, self.k = (uuid.uuid4() for _ in range(5))

    async def plant(self, engine: AsyncEngine) -> None:
        async with engine.begin() as conn:
            for user_id, name in ((self.nora, NORA), (self.lena, LENA)):
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
            await _conversation(conn, self.c1, owner=self.nora, title="春夏凉鞋合集", created=-60)
            await _conversation(conn, self.c2, owner=self.lena, title="滑板街拍", created=-60)
            await _conversation(
                conn,
                self.c4,
                owner=self.lena,
                title="凉鞋合集（分叉）",
                created=50,
                forked_from=self.c1,
            )
            await _conversation(
                conn, self.c5, owner=self.lena, title="空分叉", created=70, forked_from=self.c1
            )

            nora_c1: dict[str, Any] = {"owner": self.nora, "user_name": NORA}
            await _video(
                conn,
                self.a,
                self.c1,
                **nora_c1,
                shot=1,
                created=0,
                finished=5,
                url_name="a",
                request={"shot": SHOT_ONE, "prompt": SHOT_ONE_PROMPT},
            )
            await _video(
                conn,
                self.b,
                self.c1,
                **nora_c1,
                shot=1,
                created=60,
                finished=65,
                url_name="b",
                request={"prompt": MARKER_PROMPT},
            )
            await _composite(
                conn,
                self.m,
                self.c1,
                **nora_c1,
                base=self.a,
                created=90,
                finished=92,
                url_name="m",
                duration_ms=7040,
            )
            await _video(
                conn,
                self.c,
                self.c1,
                **nora_c1,
                shot=2,
                created=20,
                finished=None,
                url_name="c",
                status=STATUS_FAILED,
            )
            await _video(conn, self.d, self.c1, **nora_c1, shot=2, created=30, finished=50)
            await _video(conn, self.d2, self.c1, **nora_c1, shot=2, created=40, finished=45)
            await _video(conn, self.p, self.c1, **nora_c1, shot=None, created=10, finished=12)
            await _composite(
                conn, self.pc, self.c1, **nora_c1, base=self.p, created=79, finished=80
            )
            await _video(conn, self.q, self.c1, **nora_c1, shot=None, created=11, finished=13)

            await _video(
                conn,
                self.e,
                self.c2,
                owner=self.lena,
                user_name=LENA,
                shot=1,
                created=40,
                finished=130,
                request={"prompt": "滑板 100% 落地。"},
            )
            await _edit(
                conn, self.e_edit, self.c2, owner=self.lena, base=self.e, created=131, finished=132
            )

            await _composite(
                conn,
                self.y,
                self.c4,
                owner=self.lena,
                user_name=SARA,
                base=self.a,
                created=100,
                finished=101,
                url_name="y",
                duration_ms=6500,
            )
            await _video(
                conn,
                self.g,
                self.c4,
                owner=self.lena,
                user_name=LENA,
                shot=1,
                created=110,
                finished=120,
            )

            await _video(
                conn,
                self.h,
                None,
                owner=self.nora,
                user_name=SARA,
                shot=None,
                created=10,
                finished=14,
                request={"prompt": "一条横版的纯文本描述。", "aspect_ratio": "16:9"},
            )
            await _composite(
                conn,
                self.hc,
                None,
                owner=self.nora,
                user_name=SARA,
                base=self.h,
                created=40,
                finished=42,
            )
            await _video(
                conn,
                self.k,
                None,
                owner=self.lena,
                user_name=LENA,
                shot=None,
                created=15,
                finished=16,
            )


async def _conversation(
    conn: AsyncConnection,
    conversation_id: uuid.UUID,
    *,
    owner: uuid.UUID,
    title: str,
    created: float,
    forked_from: uuid.UUID | None = None,
) -> None:
    await conn.execute(
        text(
            "INSERT INTO iclip.conversations (id, owner_user_id, agent_id, title, created_at,"
            " updated_at, forked_from, fork_turn)"
            " VALUES (:id, :owner, 'storyboard', :title, :at, :at, :forked_from, :fork_turn)"
        ),
        {
            "id": conversation_id,
            "owner": owner,
            "title": title,
            "at": at(created),
            "forked_from": forked_from,
            "fork_turn": 1 if forked_from else None,
        },
    )


async def _video(
    conn: AsyncConnection,
    video_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    owner: uuid.UUID,
    user_name: str,
    shot: int | None,
    created: float,
    finished: float | None,
    url_name: str | None = None,
    status: str = STATUS_COMPLETED,
    request: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """一条出片；地址按 ``url_name`` 起，缺省用 id。"""

    name = url_name or str(video_id)
    body: dict[str, Any] = {
        "model": "vendor-b-seedance-2-5",
        "prompt": "占位正文。",
        "user_name": user_name,
        "aspect_ratio": "9:16",
        "seconds": 10,
        "reference_image_urls": ["https://oss.example.test/frame-1.jpg"],
        **(request or {}),
    }
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, shot_index, output, created_at,"
            " finished_at, metadata)"
            " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
            " CAST(:request AS jsonb), :status, :shot, CAST(:output AS jsonb), :created_at,"
            " :finished_at, CAST(:metadata AS jsonb))"
        ),
        {
            "id": video_id,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_GENERATE,
            "request": json.dumps(body),
            "metadata": None if metadata is None else json.dumps(metadata),
            "status": status,
            "shot": shot,
            "output": json.dumps({"url": url(name), "watermark_url": url(f"{name}-wm")})
            if status == STATUS_COMPLETED
            else None,
            "created_at": at(created),
            "finished_at": None if finished is None else at(finished),
        },
    )


async def _edit(
    conn: AsyncConnection,
    edit_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    owner: uuid.UUID,
    base: uuid.UUID,
    created: float,
    finished: float,
) -> None:
    """在 ``base`` 那条素材片上改一段：来源是它，原作与镜号随它。"""

    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
            " output, created_at, finished_at)"
            " SELECT :id, :owner, CAST(:conversation_id AS uuid), :kind, :operation, 'test',"
            " CAST(:request AS jsonb), :status, shot_index, id, COALESCE(root_job_id, id),"
            " CAST(:output AS jsonb), :created_at, :finished_at"
            " FROM iclip.generation_jobs WHERE id = :base"
        ),
        {
            "id": edit_id,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_GENERATE,
            "request": json.dumps(
                {
                    "model": "vendor-b-seedance-2-5",
                    "prompt": "改一段。",
                    "range_start_ms": 1000,
                    "range_end_ms": 4000,
                }
            ),
            "status": STATUS_COMPLETED,
            "base": base,
            "output": json.dumps({"url": url(f"{edit_id}-edit")}),
            "created_at": at(created),
            "finished_at": at(finished),
        },
    )


async def _composite(
    conn: AsyncConnection,
    composite_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    *,
    owner: uuid.UUID,
    user_name: str,
    base: uuid.UUID,
    created: float,
    finished: float,
    url_name: str | None = None,
    duration_ms: int | None = None,
) -> None:
    """在 ``base`` 那条素材片上剪一段再合成：先落编辑段（合成前两分钟建、前一分钟完成），合成以基底为
    来源、把编辑段夹进去，原作与镜号随基底。合成请求按别名落库，归属标签的键是 ``userName``。"""

    edit_id = uuid.uuid4()
    await _edit(
        conn,
        edit_id,
        conversation_id,
        owner=owner,
        base=base,
        created=created - 2,
        finished=created - 1,
    )
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, shot_index, source_job_id, root_job_id,"
            " output, created_at, finished_at)"
            " SELECT :id, :owner, CAST(:conversation_id AS uuid), :kind, :operation, 'local',"
            " CAST(:request AS jsonb), :status, shot_index, id, COALESCE(root_job_id, id),"
            " CAST(:output AS jsonb), :created_at, :finished_at"
            " FROM iclip.generation_jobs WHERE id = :base"
        ),
        {
            "id": composite_id,
            "owner": owner,
            "conversation_id": conversation_id,
            "kind": KIND_VIDEO,
            "operation": OPERATION_COMPOSE,
            "request": json.dumps(
                {
                    "segments": [
                        {
                            "sourceJobId": str(edit_id),
                            "url": url(f"{edit_id}-edit"),
                            "start": 0,
                            "end": 3,
                        }
                    ],
                    "userName": user_name,
                }
            ),
            "status": STATUS_COMPLETED,
            "base": base,
            "output": json.dumps(
                {"url": url(url_name or str(composite_id))}
                | ({} if duration_ms is None else {"duration_ms": duration_ms})
            ),
            "created_at": at(created),
            "finished_at": at(finished),
        },
    )


@pytest.fixture
async def seed(engine: AsyncEngine) -> Seed:
    planted = Seed()
    await planted.plant(engine)
    return planted


@pytest.fixture
def reports(engine: AsyncEngine) -> PgLibraryReports:
    return PgLibraryReports(engine)


async def ids(reports: PgLibraryReports, scope: Scope) -> list[uuid.UUID]:
    return [row.video.id for row in await reports.videos(scope, limit=20, after=None)]


async def test_library_sees_what_the_generation_repository_sees(
    engine: AsyncEngine, reports: PgLibraryReports
) -> None:
    """资料库手写的继承规则与生成仓储的是同一条：三层链逐跳边界、分叉时在途之后才完成的只进父、
    编辑段读得到却不是一版。"""

    chain = await three_level_fork(engine)
    repo = SqlGenerationRepository(engine)
    inheritance = await SqlConversationRepository(engine).ancestry(chain.child.id)
    listed = await repo.list_for_owner(
        owner=None, limit=50, conversation_id=chain.child.id, inherited=inheritance
    )
    masters = {
        job.id for job in listed if job.operation == OPERATION_COMPOSE or job.source_job_id is None
    }

    child = {v.job_id for g in await reports.groups_of(chain.child.id) for v in g.versions}
    parent = {v.job_id for g in await reports.groups_of(chain.parent.id) for v in g.versions}

    assert child == masters == {chain.own.id, chain.from_parent.id, chain.from_grand.id}
    assert parent == {
        chain.from_parent.id,
        chain.in_flight.id,
        chain.parent_after_child.id,
        chain.from_grand.id,
    }
    card = await reports.card_of(chain.child.id)
    assert card is not None and card.video.version_count == 3
    assert card.video.face.job_id == chain.own.id
    assert await reports.card_of(chain.parent.id) is not None
    assert await reports.card_of(chain.grand.id) is not None


async def test_one_card_per_conversation_ordered_by_the_face_finish_time(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """E 建得早、完成得晚，排最前；它上面更晚完成的编辑段不当卡面。"""

    rows = await reports.videos(Scope(), limit=20, after=None)

    cards = [
        (
            row.video.id,
            row.video.face.job_id,
            row.video.face.kind,
            row.video.group_count,
            row.video.version_count,
        )
        for row in rows
    ]
    assert cards == [
        (seed.c2, seed.e, "take", 1, 1),
        (seed.c4, seed.g, "take", 4, 7),
        (seed.c1, seed.m, "composite", 4, 8),
        (seed.h, seed.hc, "composite", 1, 2),
        (seed.k, seed.k, "take", 1, 1),
    ]
    faces_at = [at(130), at(120), at(92), at(42), at(16)]
    assert [row.video.face.finished_at for row in rows] == faces_at
    assert await reports.count(Scope()) == 5


async def test_a_fork_card_holds_what_it_inherits_plus_its_own(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """c4 读得到 c1 在它建立前完成的（D 正好等于边界也算），加上自己的 Y 与 G；B、M、PC 完成得晚，
    不进来。没镜号的 P、Q 各自一组。"""

    groups = await reports.groups_of(seed.c4)

    assert shape(groups) == [
        (1, [seed.a, seed.y, seed.g]),
        (2, [seed.d2, seed.d]),
        (None, [seed.p]),
        (None, [seed.q]),
    ]
    composite = groups[0].versions[1]
    assert composite.kind == "composite" and composite.take.id == seed.a
    assert composite.take.script is not None
    assert [cut.prompt for cut in composite.take.script.timeline] == SHOT_ONE_CUTS
    assert composite.user_name == LENA, "每一版的作者是它的属主，不看请求里的名字"
    assert composite.duration_ms == 6500 and composite.watermark_output_url is None
    inherited = groups[0].versions[0]
    assert inherited.kind == "take" and inherited.user_name == NORA
    assert inherited.watermark_output_url == url("a-wm") and inherited.duration_ms is None

    row = await reports.card_of(seed.c4)
    assert row is not None
    video = row.video
    assert (video.id, video.conversation_id, video.title) == (seed.c4, seed.c4, "凉鞋合集（分叉）")
    assert (video.group_count, video.version_count) == (4, 7)
    assert video.face.job_id == seed.g and video.user_name == LENA
    assert row.conversation_owner == seed.lena and not row.conversation_deleted


async def test_the_source_card_is_not_touched_by_its_forks(
    reports: PgLibraryReports, seed: Seed
) -> None:
    """c1 的卡只装 c1 读得到的：c4 在继承来的 A 上剪的 Y 不进来。卡面 M 是合成，脚本沿原作 A。"""

    groups = await reports.groups_of(seed.c1)

    assert shape(groups) == [
        (1, [seed.a, seed.b, seed.m]),
        (2, [seed.d2, seed.d]),
        (None, [seed.p, seed.pc]),
        (None, [seed.q]),
    ]
    parsed = groups[0].versions[1].take.script
    assert parsed is not None and parsed.global_settings == "浅灰地面与白墙。"
    assert [(cut.start, cut.end, cut.image_indexes) for cut in parsed.timeline] == [
        (0, 4, [1]),
        (4, 8, []),
    ]
    assert groups[0].versions[1].take.prompt == MARKER_PROMPT

    row = await reports.card_of(seed.c1)
    assert row is not None
    video = row.video
    assert video.face.kind == "composite" and video.face.job_id == seed.m
    assert video.face.output_url == url("m") and video.face.watermark_output_url is None
    assert video.face.duration_ms == 7040 and video.face.finished_at == at(92)
    assert video.take.id == seed.a and video.take.script is not None
    assert [cut.prompt for cut in video.take.script.timeline] == SHOT_ONE_CUTS
    assert (video.group_count, video.version_count) == (4, 8)
    assert video.user_name == NORA and video.agent_id == "storyboard"


async def test_a_fork_with_nothing_of_its_own_has_no_card(
    reports: PgLibraryReports, seed: Seed
) -> None:
    assert await reports.card_of(seed.c5) is None
    assert await reports.groups_of(seed.c5) == []
    assert seed.c5 not in await ids(reports, Scope())


async def test_a_take_without_a_conversation_is_a_card_with_its_composites(
    reports: PgLibraryReports, seed: Seed
) -> None:
    row = await reports.card_of(seed.h)

    assert row is not None
    video = row.video
    assert (video.id, video.conversation_id, video.title) == (seed.h, None, None)
    assert row.conversation_owner is None and not row.conversation_deleted
    assert video.face.job_id == seed.hc and video.take.id == seed.h
    assert video.take.script is None and video.take.aspect_ratio == "16:9"
    assert video.user_name == NORA
    groups = await reports.groups_of(seed.h)
    assert shape(groups) == [(None, [seed.h, seed.hc])]
    assert [version.user_name for version in groups[0].versions] == [NORA, NORA]
    assert shape(await reports.groups_of(seed.k)) == [(None, [seed.k])]


async def test_ids_that_are_not_cards_find_nothing(reports: PgLibraryReports, seed: Seed) -> None:
    for outside in (seed.a, seed.c, seed.m, seed.e_edit, uuid.uuid4()):
        assert await reports.card_of(outside) is None
        assert await reports.groups_of(outside) == []


async def test_filters_look_only_at_the_card_itself(reports: PgLibraryReports, seed: Seed) -> None:
    assert await ids(reports, Scope(user_name=LENA)) == [seed.c2, seed.c4, seed.k]
    assert await ids(reports, Scope(user_name=NORA)) == [seed.c1, seed.h]
    assert await ids(reports, Scope(user_name=SARA)) == [], "作者是属主，不是请求里的名字"
    assert await ids(reports, Scope(orientation="landscape")) == [seed.h]
    assert seed.h not in await ids(reports, Scope(orientation="portrait"))
    assert await ids(reports, Scope(since=at(91), until=at(93))) == [seed.c1]
    assert await ids(reports, Scope(q="凉鞋合集")) == [seed.c4, seed.c1]
    # 卡面 M 对应的出片 A 的正文；c4 卡面 G 的正文里没有
    assert await ids(reports, Scope(q="夹趾")) == [seed.c1]
    assert await ids(reports, Scope(q="100%")) == [seed.c2]
    assert await ids(reports, Scope(q="100_")) == []
    assert await reports.count(Scope(user_name=NORA)) == 2


async def test_authors_count_cards_per_author(reports: PgLibraryReports, seed: Seed) -> None:
    authors = [(author.user_name, author.count) for author in await reports.authors()]

    assert authors == [(LENA, 3), (NORA, 2)]


async def test_keyset_pages_follow_the_face_finish_time(
    reports: PgLibraryReports, seed: Seed
) -> None:
    first = await reports.videos(Scope(), limit=2, after=None)
    last = first[-1].video
    second = await reports.videos(
        Scope(), limit=10, after=VideoCursor(at=last.face.finished_at, video_id=last.id)
    )

    assert [row.video.id for row in first] == [seed.c2, seed.c4]
    assert [row.video.id for row in second] == [seed.c1, seed.h, seed.k]


async def test_deleting_a_conversation_keeps_every_card(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    before = shape(await reports.groups_of(seed.c4))
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.conversations SET deleted_at = :at WHERE id = :id"),
            {"at": at(500), "id": seed.c1},
        )

    assert await ids(reports, Scope()) == [seed.c2, seed.c4, seed.c1, seed.h, seed.k]
    assert shape(await reports.groups_of(seed.c4)) == before
    source = await reports.card_of(seed.c1)
    fork = await reports.card_of(seed.c4)
    assert source is not None and source.conversation_deleted
    assert source.video.title == "春夏凉鞋合集"
    assert fork is not None and not fork.conversation_deleted


async def test_a_dangling_conversation_id_counts_as_no_conversation(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """生成记录的对话 id 没有外键，指向不存在的对话时按不挂对话算：卡 id 是出片 id。"""

    stray = uuid.uuid4()
    async with engine.begin() as conn:
        await _video(
            conn,
            stray,
            uuid.uuid4(),
            owner=seed.lena,
            user_name=LENA,
            shot=1,
            created=190,
            finished=200,
        )

    row = await reports.card_of(stray)
    assert row is not None
    assert (row.video.id, row.video.conversation_id, row.video.title) == (stray, None, None)
    assert (await ids(reports, Scope()))[0] == stray


async def test_a_reference_test_video_is_not_a_card(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """参考视频的试生成只是拿来对照拆解的：``metadata`` 带 ``referenceId`` 的出片不成卡；别的坐标
    不影响，同样的出片照成卡。"""

    before = await ids(reports, Scope())
    trial, take = uuid.uuid4(), uuid.uuid4()
    async with engine.begin() as conn:
        for job_id, metadata in ((trial, {"referenceId": str(uuid.uuid4())}), (take, {"k": 1})):
            await _video(
                conn,
                job_id,
                None,
                owner=seed.nora,
                user_name=NORA,
                shot=None,
                created=190,
                finished=200,
                metadata=metadata,
            )

    assert await reports.card_of(trial) is None
    assert await reports.card_of(take) is not None
    assert await ids(reports, Scope()) == [take, *before]


async def test_a_video_upload_is_not_a_card_or_a_version(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """上传的视频不是通过本系统生成的：不挂对话也不自成一张卡，不进任何卡的版本。"""

    before = await ids(reports, Scope())
    before_c1 = shape(await reports.groups_of(seed.c1))
    upload = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.generation_jobs (id, owner_user_id, kind, operation,"
                " status, output, created_at, finished_at)"
                " VALUES (:id, :owner, :kind, :operation, :status, CAST(:output AS jsonb),"
                " :at, :at)"
            ),
            {
                "id": upload,
                "owner": seed.nora,
                "kind": KIND_VIDEO,
                "operation": OPERATION_UPLOAD,
                "status": STATUS_COMPLETED,
                "output": json.dumps({"url": url("uploaded")}),
                "at": at(300),
            },
        )

    assert await ids(reports, Scope()) == before
    assert await reports.card_of(upload) is None
    assert shape(await reports.groups_of(seed.c1)) == before_c1


async def test_subtitle_records_are_not_cards_or_versions(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """字幕记录是素材片的附属结果，不是片：挂在对话上、完成得比卡面还晚，卡与版本都不变。"""

    before = await ids(reports, Scope())
    before_c1 = shape(await reports.groups_of(seed.c1))
    subtitles = [uuid.uuid4(), uuid.uuid4()]
    async with engine.begin() as conn:
        for subtitle, status, sentences in zip(
            subtitles, (STATUS_COMPLETED, STATUS_FAILED), ('{"sentences": []}', None), strict=True
        ):
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                    " operation, provider, request, status, source_job_id, output,"
                    " created_at, finished_at)"
                    " VALUES (:id, :owner, :conversation, :kind, :operation, 'qwen_asr',"
                    " CAST(:request AS jsonb), :status, :source, CAST(:sentences AS jsonb),"
                    " :at, :at)"
                ),
                {
                    "id": subtitle,
                    "owner": seed.nora,
                    "conversation": seed.c1,
                    "kind": KIND_SUBTITLE,
                    "operation": OPERATION_GENERATE,
                    "request": json.dumps({"model": "m", "videoUrl": url("a")}),
                    "status": status,
                    "source": seed.a,
                    "sentences": sentences,
                    "at": at(500),
                },
            )

    assert await ids(reports, Scope()) == before
    assert all([await reports.card_of(subtitle) is None for subtitle in subtitles])
    assert shape(await reports.groups_of(seed.c1)) == before_c1


async def test_audio_records_are_not_cards_or_versions(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """音频记录不是片：挂在对话上的背景音乐（完成得比卡面还晚）与一条上传的音乐，卡与版本都不变。"""

    before = await ids(reports, Scope())
    before_c1 = shape(await reports.groups_of(seed.c1))
    generated, uploaded = uuid.uuid4(), uuid.uuid4()
    async with engine.begin() as conn:
        for record, conversation, operation, request, duration_ms in (
            (
                generated,
                seed.c1,
                OPERATION_GENERATE,
                json.dumps({"model": "m", "prompt": "轻快"}),
                30_000,
            ),
            (uploaded, None, OPERATION_UPLOAD, None, None),
        ):
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                    " operation, provider, request, status, output,"
                    " created_at, finished_at)"
                    " VALUES (:id, :owner, :conversation, :kind, :operation, 'qwen_music',"
                    " CAST(:request AS jsonb), :status, CAST(:output AS jsonb), :at, :at)"
                ),
                {
                    "id": record,
                    "owner": seed.nora,
                    "conversation": conversation,
                    "kind": KIND_AUDIO,
                    "operation": operation,
                    "request": request,
                    "status": STATUS_COMPLETED,
                    "output": json.dumps(
                        {"url": f"https://example.test/{record}.m4a"}
                        | ({} if duration_ms is None else {"duration_ms": duration_ms})
                    ),
                    "at": at(500),
                },
            )

    assert await ids(reports, Scope()) == before
    assert await reports.card_of(generated) is None
    assert await reports.card_of(uploaded) is None
    assert shape(await reports.groups_of(seed.c1)) == before_c1


async def _whole_film(
    conn: AsyncConnection,
    film_id: uuid.UUID,
    conversation_id: uuid.UUID,
    *,
    owner: uuid.UUID,
    finished: float | None,
    sources: Sequence[uuid.UUID] = (),
    status: str = STATUS_COMPLETED,
) -> None:
    """挂在 ``conversation_id`` 上的一次成片导出，画面轨按先后用到 ``sources``；只有完成的有地址，
    还没结束的没有完成时刻。"""

    completed = status == STATUS_COMPLETED
    await conn.execute(
        text(
            "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
            " operation, provider, request, status, output, created_at, finished_at)"
            " VALUES (:id, :owner, :conversation, :kind, :operation, :provider,"
            " CAST(:request AS jsonb), :status, CAST(:output AS jsonb), :created_at, :at)"
        ),
        {
            "id": film_id,
            "owner": owner,
            "conversation": conversation_id,
            "kind": KIND_WHOLE_FILM,
            "operation": OPERATION_RENDER,
            "provider": RENDER_PROVIDER,
            "request": json.dumps(request_to_payload(whole_film_request(*sources))),
            "status": status,
            "output": json.dumps({"url": url(f"film-{film_id}")}) if completed else None,
            "created_at": at((finished or 600) - 1),
            "at": None if finished is None else at(finished),
        },
    )


async def test_whole_films_are_not_cards_or_versions(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """素材卡不收成片：挂在有卡的对话上、完成得比卡面还晚，卡面、组与版都不变；挂在一段没有
    别的素材片的对话上，也不成卡。"""

    before = await ids(reports, Scope())
    before_c1 = shape(await reports.groups_of(seed.c1))
    in_c1, alone = uuid.uuid4(), uuid.uuid4()
    async with engine.begin() as conn:
        for film, conversation in ((in_c1, seed.c1), (alone, seed.c5)):
            await _whole_film(
                conn, film, conversation, owner=seed.nora, finished=500, sources=[seed.a]
            )

    assert await ids(reports, Scope()) == before
    assert await reports.card_of(alone) is None
    assert await reports.card_of(seed.c5) is None
    assert shape(await reports.groups_of(seed.c1)) == before_c1


async def test_a_trial_is_never_a_face(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """c2 里比 E 晚完成的试生成不顶替卡面、不算一版；只有试生成的对话没有卡。"""

    before = await ids(reports, Scope())
    only_trials = uuid.uuid4()
    async with engine.begin() as conn:
        await _conversation(conn, only_trials, owner=seed.nora, title="只试生成过", created=150)
        for conversation, owner, name in (
            (seed.c2, seed.lena, LENA),
            (only_trials, seed.nora, NORA),
        ):
            await _video(
                conn,
                uuid.uuid4(),
                conversation,
                owner=owner,
                user_name=name,
                shot=1,
                created=190,
                finished=200,
                metadata={"referenceId": str(uuid.uuid4())},
            )

    assert await ids(reports, Scope()) == before
    assert await reports.count(Scope()) == len(before)
    card = await reports.card_of(seed.c2)
    assert card is not None and card.video.face.job_id == seed.e
    assert (card.video.group_count, card.video.version_count) == (1, 1)
    assert await reports.card_of(only_trials) is None
    assert await reports.groups_of(only_trials) == []
    assert [(author.user_name, author.count) for author in await reports.authors()] == [
        (LENA, 3),
        (NORA, 2),
    ]


async def test_unattached_masters_make_one_card_per_take(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """不挂对话与挂在不存在的对话上的素材片一起按原作成卡：不挂对话的 T 与它上面挂在不存在的对话上的
    合成 TC 是一张卡；都挂在不存在的对话上的 U 与 UC 是一张卡；在 c1 的 A 上合成、不挂对话的 AC 自成
    一张卡，卡 id 是 A、作者是 A 的属主，c1 的卡不变。"""

    t, tc, u, uc, ac, ghost = (uuid.uuid4() for _ in range(6))
    before_c1 = shape(await reports.groups_of(seed.c1))
    nora: dict[str, Any] = {"owner": seed.nora, "user_name": NORA}
    async with engine.begin() as conn:
        await _video(
            conn, t, None, owner=seed.lena, user_name=LENA, shot=None, created=200, finished=210
        )
        await _composite(conn, tc, ghost, **nora, base=t, created=230, finished=240)
        await _video(conn, u, ghost, **nora, shot=3, created=200, finished=205)
        await _composite(conn, uc, ghost, **nora, base=u, created=220, finished=221)
        await _composite(
            conn, ac, None, owner=seed.lena, user_name=LENA, base=seed.a, created=250, finished=251
        )

    rows = await reports.videos(Scope(), limit=20, after=None)

    assert [
        (row.video.id, row.video.conversation_id, row.video.face.job_id, row.video.user_name)
        for row in rows[:3]
    ] == [(seed.a, None, ac, NORA), (t, None, tc, LENA), (u, None, uc, NORA)]
    assert [row.video.version_count for row in rows[:3]] == [1, 2, 2]
    assert [row.video.id for row in rows[3:]] == [seed.c2, seed.c4, seed.c1, seed.h, seed.k]
    assert shape(await reports.groups_of(t)) == [(None, [t, tc])]
    assert shape(await reports.groups_of(u)) == [(3, [u, uc])]
    assert shape(await reports.groups_of(seed.a)) == [(1, [ac])]
    assert shape(await reports.groups_of(seed.c1)) == before_c1
    card = await reports.card_of(seed.a)
    assert card is not None and card.video.take.id == seed.a
    assert card.conversation_owner is None and not card.conversation_deleted
    for outside in (tc, uc, ac, ghost):
        assert await reports.card_of(outside) is None
        assert await reports.groups_of(outside) == []
    assert await ids(reports, Scope(user_name=LENA)) == [t, seed.c2, seed.c4, seed.k]


@pytest.mark.parametrize(
    "scope",
    [
        Scope(),
        Scope(user_name=LENA),
        Scope(user_name=NORA),
        Scope(since=at(15), until=at(125)),
        Scope(orientation="portrait"),
        Scope(orientation="landscape", user_name=NORA),
        Scope(q="凉鞋"),
        Scope(q="凉鞋", since=at(100)),
    ],
    ids=[
        "all",
        "lena",
        "nora",
        "time",
        "portrait",
        "landscape-nora",
        "keyword",
        "keyword-time",
    ],
)
async def test_one_card_pages_walk_the_whole_list_and_match_the_count(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed, scope: Scope
) -> None:
    """一页一张地翻，与一次取全的列表逐张相同、不重不漏；计数与列表同一套候选。另加一张挂在不存在的
    对话上的卡。"""

    async with engine.begin() as conn:
        await _video(
            conn,
            uuid.uuid4(),
            uuid.uuid4(),
            owner=seed.lena,
            user_name=LENA,
            shot=None,
            created=135,
            finished=140,
        )
    listed = await ids(reports, scope)

    walked: list[uuid.UUID] = []
    after: VideoCursor | None = None
    while rows := await reports.videos(scope, limit=1, after=after):
        video = rows[0].video
        walked.append(video.id)
        after = VideoCursor(at=video.face.finished_at, video_id=video.id)

    assert listed
    assert walked == listed
    assert await reports.count(scope) == len(listed)


async def test_authors_match_the_authors_on_the_list(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed
) -> None:
    """作者按卡计数：对话卡记对话属主，不挂对话（含对话不存在）的卡记原作出片的属主。"""

    async with engine.begin() as conn:
        await _video(
            conn,
            uuid.uuid4(),
            uuid.uuid4(),
            owner=seed.nora,
            user_name=LENA,
            shot=None,
            created=135,
            finished=140,
        )
    listed = Counter(
        row.video.user_name for row in await reports.videos(Scope(), limit=50, after=None)
    )

    authors = [(author.user_name, author.count) for author in await reports.authors()]

    assert authors == [(LENA, 3), (NORA, 3)]
    assert dict(authors) == listed


class Films:
    """在 ``Seed`` 上加的成片导出，时刻同样是距 BASE 的分钟数。

    c1（Nora）：W0（45 完成，c4、c5 建立前就有）、W1（200，用到 A、D）、Lena 记在这段对话上的 W2（300，
    卡面，用到 D、A、B），另有一条失败的与一条还没结束的。c4（Lena 的副本）：自己的 W4（250）。
    c2（Lena）：只有组件段的 W5（150，没有用到素材片）。c5 没有自己的导出。还有一条挂在不存在的对话上的。
    """

    def __init__(self) -> None:
        self.w0, self.w1, self.w2, self.w4, self.w5 = (uuid.uuid4() for _ in range(5))
        self.failed, self.running, self.dangling = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    async def plant(self, engine: AsyncEngine, seed: Seed) -> None:
        async with engine.begin() as conn:
            await _whole_film(
                conn, self.w0, seed.c1, owner=seed.nora, finished=45, sources=[seed.a]
            )
            await _whole_film(
                conn, self.w1, seed.c1, owner=seed.nora, finished=200, sources=[seed.a, seed.d]
            )
            await _whole_film(
                conn,
                self.w2,
                seed.c1,
                owner=seed.lena,
                finished=300,
                sources=[seed.d, seed.a, seed.b],
            )
            await _whole_film(
                conn,
                self.failed,
                seed.c1,
                owner=seed.nora,
                finished=400,
                sources=[seed.a],
                status=STATUS_FAILED,
            )
            await _whole_film(
                conn,
                self.running,
                seed.c1,
                owner=seed.nora,
                finished=None,
                sources=[seed.a],
                status=STATUS_SUBMITTED,
            )
            await _whole_film(
                conn, self.w4, seed.c4, owner=seed.lena, finished=250, sources=[seed.g]
            )
            await _whole_film(conn, self.w5, seed.c2, owner=seed.lena, finished=150)
            await _whole_film(
                conn, self.dangling, uuid.uuid4(), owner=seed.lena, finished=500, sources=[seed.k]
            )


@pytest.fixture
async def films(engine: AsyncEngine, seed: Seed) -> Films:
    planted = Films()
    await planted.plant(engine, seed)
    return planted


async def film_cards(
    reports: PgLibraryReports, scope: WholeFilmScope, *, limit: int = 20
) -> list[uuid.UUID]:
    return [
        row.card.conversation_id
        for row in await reports.whole_films(scope, limit=limit, after=None)
    ]


async def test_a_whole_film_card_holds_its_conversations_own_exports(
    reports: PgLibraryReports, seed: Seed, films: Films
) -> None:
    """一段对话一张卡，只装自己完成的导出：c4、c5 不继承 c1 的，c5 因此没有卡；失败的、还没结束的、
    挂在不存在的对话上的都不收。卡里按完成先后编版本，卡面是最后一版；作者是对话属主，每一版的归属人
    是导出的人，用到的素材片按请求里的先后。"""

    rows = await reports.whole_films(WholeFilmScope(), limit=20, after=None)

    assert [
        (row.card.conversation_id, [version.job_id for version in row.card.versions])
        for row in rows
    ] == [
        (seed.c1, [films.w0, films.w1, films.w2]),
        (seed.c4, [films.w4]),
        (seed.c2, [films.w5]),
    ]
    assert await reports.count_whole_films(WholeFilmScope()) == 3

    c1 = rows[0]
    card = c1.card
    assert card.face == card.versions[-1]
    assert (card.title, card.user_name) == ("春夏凉鞋合集", NORA)
    assert [version.user_name for version in card.versions] == [NORA, NORA, LENA]
    assert [version.finished_at for version in card.versions] == [at(45), at(200), at(300)]
    assert [version.source_job_ids for version in card.versions] == [
        [seed.a],
        [seed.a, seed.d],
        [seed.d, seed.a, seed.b],
    ]
    assert card.face.output_url == url(f"film-{films.w2}")
    assert (c1.conversation_owner, c1.conversation_deleted) == (seed.nora, False)
    assert (rows[1].card.title, rows[1].card.user_name) == ("凉鞋合集（分叉）", LENA)
    assert rows[2].card.face.source_job_ids == []


async def test_high_definition_versions_are_neither_takes_nor_exports(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed, films: Films
) -> None:
    """高清版（超分记录）完成得比所有卡面都晚，素材卡、组、版与成片卡、成片版本都不变：
    素材片与成片的高清版种类都是视频，都不挂对话。"""

    before = await ids(reports, Scope())
    before_c1 = shape(await reports.groups_of(seed.c1))
    before_films = [
        (row.card.conversation_id, [version.job_id for version in row.card.versions])
        for row in await reports.whole_films(WholeFilmScope(), limit=20, after=None)
    ]
    async with engine.begin() as conn:
        for source in (seed.a, seed.m, films.w2):
            request = VideoEnhanceRequest(
                model="video-enhance",
                resolution="1080p",
                fps=30,
                video_url=url(f"source-{source}"),
                user_name=NORA,
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs (id, owner_user_id, conversation_id, kind,"
                    " operation, provider, request, status, output,"
                    " source_job_id, created_at, finished_at)"
                    " VALUES (:id, :owner, NULL, :kind, :operation, 'video_api',"
                    " CAST(:request AS jsonb), :status, CAST(:output AS jsonb), :source,"
                    " :created_at, :at)"
                ),
                {
                    "id": uuid.uuid4(),
                    "owner": seed.lena,
                    "kind": KIND_VIDEO,
                    "operation": OPERATION_ENHANCE,
                    "request": json.dumps(request_to_payload(request)),
                    "status": STATUS_COMPLETED,
                    "output": json.dumps(
                        {"url": url(f"hd-{source}"), "watermark_url": url(f"hd-wm-{source}")}
                    ),
                    "source": source,
                    "created_at": at(899),
                    "at": at(900),
                },
            )

    assert await ids(reports, Scope()) == before
    assert shape(await reports.groups_of(seed.c1)) == before_c1
    assert [
        (row.card.conversation_id, [version.job_id for version in row.card.versions])
        for row in await reports.whole_films(WholeFilmScope(), limit=20, after=None)
    ] == before_films


async def test_whole_film_filters_and_pages_follow_the_face(
    reports: PgLibraryReports, seed: Seed, films: Films
) -> None:
    """作者、时间窗与关键词都只看卡本身：时间窗落在卡面的完成时刻上（c1 的 W1 在窗里也不算），关键词
    只搜对话标题。翻页按卡面完成时刻倒序接着走。"""

    assert await film_cards(reports, WholeFilmScope(user_name=LENA)) == [seed.c4, seed.c2]
    assert await film_cards(reports, WholeFilmScope(user_name=NORA)) == [seed.c1]
    assert await film_cards(reports, WholeFilmScope(since=at(100), until=at(210))) == [seed.c2]
    assert await film_cards(reports, WholeFilmScope(since=at(250))) == [seed.c1, seed.c4]
    assert await film_cards(reports, WholeFilmScope(until=at(250))) == [seed.c2]
    assert await film_cards(reports, WholeFilmScope(q="凉鞋合集")) == [seed.c1, seed.c4]
    assert await film_cards(reports, WholeFilmScope(q="滑板")) == [seed.c2]
    assert await reports.count_whole_films(WholeFilmScope(user_name=LENA)) == 2

    first = await reports.whole_films(WholeFilmScope(), limit=2, after=None)
    last = first[-1].card
    second = await reports.whole_films(
        WholeFilmScope(),
        limit=10,
        after=VideoCursor(at=last.face.finished_at, video_id=last.conversation_id),
    )
    assert [row.card.conversation_id for row in first] == [seed.c1, seed.c4]
    assert [row.card.conversation_id for row in second] == [seed.c2]


async def test_whole_film_authors_count_cards_by_conversation_owner(
    reports: PgLibraryReports, seed: Seed, films: Films
) -> None:
    """c1 的卡算 Nora 的（Lena 记在上面的 W2 也在里面）；Lena 有 c4 与 c2 两张。c5 没有卡，失败的与
    挂在不存在的对话上的不算。"""

    authors = [(author.user_name, author.count) for author in await reports.whole_film_authors()]

    assert authors == [(LENA, 2), (NORA, 1)]


async def test_deleting_a_conversation_keeps_its_whole_film_card(
    engine: AsyncEngine, reports: PgLibraryReports, seed: Seed, films: Films
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.conversations SET deleted_at = :at WHERE id = :id"),
            {"at": at(500), "id": seed.c1},
        )

    rows = await reports.whole_films(WholeFilmScope(), limit=20, after=None)

    assert [row.card.conversation_id for row in rows] == [seed.c1, seed.c4, seed.c2]
    assert rows[0].conversation_deleted and rows[0].card.title == "春夏凉鞋合集"
    assert len(rows[0].card.versions) == 3
