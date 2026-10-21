from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, status

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.library.models import Orientation
from iclip.domains.library.schemas import (
    HitCaseIn,
    HitCasesOut,
    HitCaseStateOut,
    HitCaseTagsIn,
    LibraryAuthorsOut,
    LibraryVideoDetailOut,
    LibraryVideosOut,
    WholeFilmCardsOut,
)
from iclip.domains.library.service import HitCaseService, LibraryService
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_library_router(service: LibraryService, hit_cases: HitCaseService) -> APIRouter:
    """打标没配置（``hit_cases.can_retag`` 为假）时不挂重新打标。"""

    router = APIRouter(prefix="/library", tags=["library"])

    @router.get("/videos", response_model=LibraryVideosOut)
    async def videos(
        principal: Annotated[Principal, require_permission("generation:read")],
        user_name: Annotated[str | None, Query(alias="userName", max_length=150)] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        orientation: Orientation | None = None,
        q: Annotated[str | None, Query(max_length=100)] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> LibraryVideosOut:
        """全站的素材片，一段对话一张卡，卡面素材片完成得晚的排前面。

        ``userName`` 筛卡的作者（对话属主）；时间窗 ``[since, until)`` 作用在卡面素材片的完成时刻上；
        ``q`` 按字面包含匹配卡面素材片对应那条出片的正文与对话标题。``total`` 只在第一页给。
        来源对话人人拿得到，``canOpenConversation`` 说这位读者打不打得开。
        """

        return await service.videos(
            principal,
            user_name=user_name,
            since=since,
            until=until,
            orientation=orientation,
            q=q,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/videos/{video_id}", response_model=LibraryVideoDetailOut)
    async def video(
        principal: Annotated[Principal, require_permission("generation:read")],
        video_id: uuid.UUID,
    ) -> LibraryVideoDetailOut:
        """一张卡：卡片本身与按镜头组分好的全部版本，含继承来的。

        ``video_id`` 是卡 id（对话 id，不挂对话的卡是出片 id），别的 id 一律 ``404``；
        对话删了照常返回。
        """

        return await service.video(principal, video_id)

    @router.get("/authors", response_model=LibraryAuthorsOut)
    async def authors(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> LibraryAuthorsOut:
        """素材卡的作者与各自的卡数，多的排前面、同数按名字，不受筛选影响；给按人筛选用。"""

        return await service.authors()

    @router.get("/whole-films/authors", response_model=LibraryAuthorsOut)
    async def whole_film_authors(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> LibraryAuthorsOut:
        """成片卡的作者与各自的卡数，多的排前面、同数按名字，不受筛选影响；给按人筛选用。"""

        return await service.whole_film_authors()

    @router.get("/whole-films", response_model=WholeFilmCardsOut)
    async def whole_films(
        principal: Annotated[Principal, require_permission("generation:read")],
        user_name: Annotated[str | None, Query(alias="userName", max_length=150)] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        q: Annotated[str | None, Query(max_length=100)] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> WholeFilmCardsOut:
        """全站导出的成片，一段对话一张卡，只算这段对话自己的导出；卡面完成得晚的排前面。

        每张卡带齐全部版本，没有详情口。``userName`` 筛卡的作者（对话属主）；时间窗
        ``[since, until)`` 作用在卡面的完成时刻上；``q`` 按字面包含匹配对话标题。
        ``total`` 只在第一页给。
        """

        return await service.whole_films(
            principal,
            user_name=user_name,
            since=since,
            until=until,
            q=q,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/hit-cases", response_model=HitCasesOut)
    async def list_hit_cases(
        _: Annotated[Principal, require_permission("generation:read")],
        tags: Annotated[list[uuid.UUID] | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> HitCasesOut:
        """爆款素材库里的素材片，入选晚的排前面。

        ``tags`` 可以重复给：同一维度里命中任一即算，不同维度都要命中，选了上级也算它的下级；不存在
        的标签是 ``422``。``total`` 只在第一页给。
        """

        return await hit_cases.list(tags=tags or (), limit=limit, cursor=cursor)

    @router.get("/hit-cases/{job_id}", response_model=HitCaseStateOut)
    async def hit_case_state(
        _: Annotated[Principal, require_permission("generation:read")],
        job_id: uuid.UUID,
    ) -> HitCaseStateOut:
        """这条素材片能不能进爆款素材库、进了没有；没有这条视频是 ``404``。"""

        return await hit_cases.state(job_id)

    @router.put("/hit-cases/{job_id}", response_model=HitCaseStateOut)
    async def add_hit_case(
        principal: Annotated[Principal, require_permission("generation:read")],
        job_id: uuid.UUID,
        body: HitCaseIn,
    ) -> HitCaseStateOut:
        """把这条素材片加进爆款素材库，连同带来的标签，并排一次打标。

        不能入选是 ``422``；已入选原样返回，不改标签、不重新打标；不存在的标签或给了维度是 ``422``。
        """

        return await hit_cases.add(principal, job_id, body.tag_ids)

    @router.put("/hit-cases/{job_id}/tags", response_model=HitCaseStateOut)
    async def replace_hit_case_tags(
        principal: Annotated[Principal, require_permission("generation:read")],
        job_id: uuid.UUID,
        body: HitCaseTagsIn,
    ) -> HitCaseStateOut:
        """整份替换这条爆款素材各维度的标签。没入选是 ``404``；正在打标是 ``409``；不存在的标签或给了
        维度是 ``422``。"""

        return await hit_cases.replace_tags(principal, job_id, body.tag_ids)

    @router.delete("/hit-cases/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def remove_hit_case(
        _: Annotated[Principal, require_permission("generation:read")],
        job_id: uuid.UUID,
    ) -> None:
        """移出爆款素材库，标签一并删掉；没入选也是 ``204``。"""

        await hit_cases.remove(job_id)

    if hit_cases.can_retag:

        @router.post("/hit-cases/{job_id}/tagging", response_model=HitCaseStateOut)
        async def retag_hit_case(
            principal: Annotated[
                Principal, require_permission("generation:read", "generation:submit")
            ],
            job_id: uuid.UUID,
        ) -> HitCaseStateOut:
            """按所在对话当前的新片执行方案重新打标：AI 维度整组重写，人工维度不动。没入选是
            ``404``；正在打标是 ``409``。"""

            return await hit_cases.retag(principal, job_id)

    return router


__all__ = ["create_library_router"]
