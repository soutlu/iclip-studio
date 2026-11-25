from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from fastapi import APIRouter, Query, Response, status

from iclip.common.final_cut import TargetLocale
from iclip.domains.identity.public import (
    ActAs,
    Principal,
    require_permission,
    resolve_user_name,
)
from iclip.domains.references.models import (
    FAST_ABOVE_BPM,
    SLOW_BELOW_BPM,
    AudioKind,
    BgmGenre,
    BgmMood,
    SfxCategory,
    Tempo,
    VoiceAge,
    VoiceGender,
    VoiceScenario,
)
from iclip.domains.references.schemas import (
    ReferenceAudioCreateIn,
    ReferenceAudioFiltersOut,
    ReferenceAudioOut,
    ReferenceAudiosOut,
    ReferenceAudioUpdateIn,
    ReferenceTagsIn,
    ReferenceVideoCreateIn,
    ReferenceVideoFiltersOut,
    ReferenceVideoOut,
    ReferenceVideosOut,
    ReferenceVideoUpdateIn,
    TestVideoIn,
)
from iclip.domains.references.service import ReferenceAudioService, ReferenceService
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT

LOCALE_UNSET: Final = "none"

# 筛语种时多一个取值：没设语种的。
LocaleFilter = Literal[TargetLocale, "none"]


def create_reference_videos_router(
    service: ReferenceService,
    *,
    act_as: ActAs,
    uploadable: bool,
    rerunnable: bool,
    retaggable: bool,
    testable: bool,
) -> APIRouter:
    router = APIRouter(prefix="/references/videos", tags=["references"])

    @router.get("", response_model=ReferenceVideosOut)
    async def list_reference_videos(
        principal: Annotated[Principal, require_permission("generation:read")],
        tags: Annotated[list[uuid.UUID] | None, Query()] = None,
        user_name: Annotated[str | None, Query(alias="userName", max_length=150)] = None,
        q: Annotated[str | None, Query(max_length=100)] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> ReferenceVideosOut:
        """全站没移除的参考视频，建立晚的排前面。

        ``tags`` 可以重复给：同一维度里命中任一即算，不同维度都要命中，选了上级也算它的下级；不存在
        的标签是 ``422``。``userName`` 筛属主；``q`` 按字面包含匹配拆解全文；时间窗
        ``[since, until)`` 作用在建立时刻上。``total`` 只在第一页给。
        """

        return await service.list(
            principal,
            tags=tags or (),
            user_name=user_name,
            q=q,
            since=since,
            until=until,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/filters", response_model=ReferenceVideoFiltersOut)
    async def reference_video_filters(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> ReferenceVideoFiltersOut:
        """名下有参考视频的属主，各带条数；只数没移除的，不受筛选影响。"""

        return await service.filters()

    @router.get("/{reference_id}", response_model=ReferenceVideoOut)
    async def get_reference_video(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
    ) -> ReferenceVideoOut:
        """一条参考视频连同当前拆解与最新一次试生成；移除了是 ``404``。"""

        return await service.get(principal, reference_id)

    @router.patch("/{reference_id}", response_model=ReferenceVideoOut)
    async def update_reference_video(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
        body: ReferenceVideoUpdateIn,
    ) -> ReferenceVideoOut:
        """属主改拆解正文，版本加一。版本对不上或正在拆解是 ``409``，别人的是 ``403``。"""

        return await service.update(principal, reference_id, body)

    @router.put("/{reference_id}/tags", response_model=ReferenceVideoOut)
    async def replace_reference_video_tags(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
        body: ReferenceTagsIn,
    ) -> ReferenceVideoOut:
        """属主整份替换各维度的标签。正在打标是 ``409``；不存在的标签或给了维度是 ``422``；别人的
        是 ``403``。"""

        return await service.replace_tags(principal, reference_id, body)

    @router.delete("/{reference_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def remove_reference_video(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
    ) -> None:
        """属主把它从资料库移除；对话里按地址仍能用它的拆解。别人的是 ``403``。"""

        await service.remove(principal, reference_id)

    if uploadable:

        @router.post("", response_model=ReferenceVideoOut, status_code=status.HTTP_201_CREATED)
        async def create_reference_video(
            principal: Annotated[Principal, require_permission("uploads:write")],
            body: ReferenceVideoCreateIn,
            response: Response,
        ) -> ReferenceVideoOut:
            """把调用者自己的一条视频上传（``uploadId``），或调用者看得到的一条已完成的素材片
            （``sourceJobId``）放进资料库，新建的排上第一次拆解（``201``）。

            同一个地址已在资料库就交回那一条（``200``），不再拆；移除过的回到资料库，属主换成调用者。
            同一个地址同时加只会建出一条。别人的上传、不是视频的上传、看不到或不是素材片的生成记录、
            不存在的 id 都是 ``404``；两个都给或都不给是 ``422``。"""

            created_row, created = await service.create(principal, body)
            if not created:
                response.status_code = status.HTTP_200_OK
            return created_row

    if rerunnable:

        @router.post("/{reference_id}/breakdowns", response_model=ReferenceVideoOut)
        async def rerun_reference_video(
            principal: Annotated[
                Principal, require_permission("generation:read", "generation:submit")
            ],
            reference_id: uuid.UUID,
        ) -> ReferenceVideoOut:
            """属主重新拆解：重新排队，拆成就覆盖拆解并重新打标，失败保留原来的。正在拆是 ``409``。"""

            return await service.rerun(principal, reference_id)

    if retaggable:

        @router.post("/{reference_id}/tagging", response_model=ReferenceVideoOut)
        async def retag_reference_video(
            principal: Annotated[
                Principal, require_permission("generation:read", "generation:submit")
            ],
            reference_id: uuid.UUID,
        ) -> ReferenceVideoOut:
            """属主按当前拆解重新打标：AI 维度整组重写，人工维度不动。拆解还没完成或正在打标是
            ``409``，别人的是 ``403``。"""

            return await service.retag(principal, reference_id)

    if testable:

        @router.post("/{reference_id}/test-generations", response_model=ReferenceVideoOut)
        async def start_reference_test_video(
            principal: Annotated[
                Principal, require_permission("generation:read", "generation:submit")
            ],
            reference_id: uuid.UUID,
            body: TestVideoIn,
        ) -> ReferenceVideoOut:
            """属主或治理者按当前拆解拼一段提示词，生成一条视频与原片对照，记在发起人名下（一条
            ``operation=trial`` 的生成记录，不算素材片），答复带上这次试生成。

            ``userName`` 同媒体生成。别人的是 ``403``；拆解还没完成、上一次试生成（不论谁发起）
            还没结束是 ``409``；拆解格式不全拼不出提示词、或拼出来超过字数上限是 ``422``。"""

            user_name = resolve_user_name(principal, body.user_name)
            principal = await act_as(principal, user_name)
            return await service.start_test_video(
                principal, reference_id, body, user_name=user_name
            )

    return router


def create_reference_audios_router(
    service: ReferenceAudioService, *, act_as: ActAs, uploadable: bool
) -> APIRouter:
    router = APIRouter(prefix="/references/audios", tags=["references"])

    @router.get("", response_model=ReferenceAudiosOut)
    async def list_reference_audios(
        principal: Annotated[Principal, require_permission("generation:read")],
        audio_kind: Annotated[AudioKind | None, Query(alias="audioKind")] = None,
        locale: Annotated[
            list[LocaleFilter] | None,
            Query(description=f"语种，可重复；``{LOCALE_UNSET}`` 是没设语种的"),
        ] = None,
        gender: Annotated[list[VoiceGender] | None, Query()] = None,
        age: Annotated[list[VoiceAge] | None, Query()] = None,
        scenario: Annotated[list[VoiceScenario] | None, Query()] = None,
        mood: Annotated[list[BgmMood] | None, Query()] = None,
        genre: Annotated[list[BgmGenre] | None, Query()] = None,
        tempo: Annotated[
            list[Tempo] | None,
            Query(
                description=f"按 bpm 分的速度档，可重复：``slow`` 低于 {SLOW_BELOW_BPM}，"
                f"``medium`` {SLOW_BELOW_BPM}～{FAST_ABOVE_BPM}，``fast`` 高于 {FAST_ABOVE_BPM}；"
                "没填 bpm 的不命中"
            ),
        ] = None,
        sfx_category: Annotated[list[SfxCategory] | None, Query(alias="sfxCategory")] = None,
        user_name: Annotated[str | None, Query(alias="userName", max_length=150)] = None,
        q: Annotated[str | None, Query(max_length=100)] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> ReferenceAudiosOut:
        """全站没移除的参考音频，建立晚的排前面。

        ``audioKind`` 筛子类（``voice`` 音色、``bgm`` 配乐、``sfx`` 音效）。``locale``、``gender``、
        ``age``、``scenario``、``mood``、``genre``、``tempo``、``sfxCategory`` 都可以重复给：同一个
        参数里命中任一即算，不同参数都要命中；``locale=none`` 筛没设语种的，``scenario`` 命中使用场景
        里的任一个，``tempo`` 按 ``bpm`` 分档。``userName`` 筛属主；``q`` 按字面包含匹配标题、备注
        与台词；时间窗 ``[since, until)`` 作用在建立时刻上。``total`` 只在第一页给。"""

        return await service.list(
            principal,
            audio_kind=audio_kind,
            locales=[None if one == LOCALE_UNSET else one for one in locale or ()],
            genders=gender or (),
            ages=age or (),
            scenarios=scenario or (),
            moods=mood or (),
            genres=genre or (),
            tempos=tempo or (),
            sfx_categories=sfx_category or (),
            user_name=user_name,
            q=q,
            since=since,
            until=until,
            limit=limit,
            cursor=cursor,
        )

    @router.get("/filters", response_model=ReferenceAudioFiltersOut)
    async def reference_audio_filters(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> ReferenceAudioFiltersOut:
        """每个子类的条数（没有的是 0）与名下有参考音频的属主，各带条数；只数没移除的。"""

        return await service.filters()

    @router.get("/{reference_id}", response_model=ReferenceAudioOut)
    async def get_reference_audio(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
    ) -> ReferenceAudioOut:
        """一条参考音频；移除了是 ``404``。"""

        return await service.get(principal, reference_id)

    @router.patch("/{reference_id}", response_model=ReferenceAudioOut)
    async def update_reference_audio(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
        body: ReferenceAudioUpdateIn,
    ) -> ReferenceAudioOut:
        """属主或治理者改标题、备注、语种、台词与属性；给了的才改，给 ``null`` 清空（``scenarios``
        也可给 ``[]``；标题不能清空）。不是音色却要留着台词、改完留着不属于本子类的属性是 ``422``，
        别人的是 ``403``。"""

        return await service.update(principal, reference_id, body)

    @router.delete("/{reference_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def remove_reference_audio(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
    ) -> None:
        """属主或治理者把它从参考音频库移除；已经用它配好的音不受影响。别人的是 ``403``。"""

        await service.remove(principal, reference_id)

    if uploadable:

        @router.post("", response_model=ReferenceAudioOut, status_code=status.HTTP_201_CREATED)
        async def create_reference_audio(
            principal: Annotated[Principal, require_permission("uploads:write")],
            body: ReferenceAudioCreateIn,
        ) -> ReferenceAudioOut:
            """把调用者自己的一条音频上传（``uploadId``），或调用者看得到的一条已完成的背景音乐
            （``sourceJobId``）放进参考音频库，每次都新建一条（``201``）。

            入库时按地址解码一遍，量时长并算波形峰值 ``peaks``：量不出来 ``422``；音色（``voice``）
            要在 3 到 30 秒之间，别的子类大于 0 即可，不合规 ``422``。台词 ``transcript`` 只有音色
            能填，``locale`` 只认 ``zh``、``en``、``de``、``es``、``fr``。属性都选填、各属其类：
            ``gender``、``age``、``scenarios``（至多 2 个、不重复）只有音色能填，``mood``、``genre``、
            ``bpm`` 只有配乐能填，``sfxCategory`` 只有音效能填，填了别的子类的是 ``422``。别人的
            上传、不是音频的上传、看不到或不是背景音乐的生成记录、不存在的 id 都是 ``404``。
            ``userName`` 同媒体生成，持 ``users:act_as`` 时替那个人放进去。"""

            user_name = resolve_user_name(principal, body.user_name)
            principal = await act_as(principal, user_name)
            return await service.create(principal, body)

    return router


__all__ = ["create_reference_audios_router", "create_reference_videos_router"]
