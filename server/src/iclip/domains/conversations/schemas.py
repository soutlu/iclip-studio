"""对话的 wire 形状。字段名按跨端约定用 camelCase。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from iclip.common.film_view import (
    FilmImagePrompt,
    FilmLineEdit,
    FilmPromptImage,
    FilmPromptRun,
    FilmPromptText,
    FilmTextEdit,
    FilmView,
    FrameKind,
    SettingKind,
)
from iclip.common.urls import is_http_url
from iclip.domains.conversations.models import (
    Conversation,
    ConversationActivity,
    EventWatermark,
)

MAX_TITLE_CHARS: Final = 200
MAX_AGENT_ID_CHARS: Final = 128
DEFAULT_TITLE: Final = "新对话"


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


Title = Annotated[str, Field(min_length=1, max_length=MAX_TITLE_CHARS)]


class ConversationAgentOut(CamelModel):
    """可发起对话的一个顶层 Agent；``name`` 是声明里给人看的名字。"""

    id: str
    name: str


class ConversationAgentsOut(CamelModel):
    """当前可发起对话的顶层 Agent 名册；``default`` 取声明顺序的第一项，空目录为 null。"""

    items: list[ConversationAgentOut]
    default: str | None


class ConversationIn(CamelModel):
    """新建一段对话。不给名字就用默认名。

    两处归属都可以先不给，之后再挂（见 ``ConversationTaskIn`` 与
    ``ConversationCollectionIn``）。
    """

    id: uuid.UUID | None = None
    """由调用方铸的对话 id，可不给（服务端生成）。给了就按它幂等：重发同一个 id
    不会多出第二段对话，答复的是已有那一段。"""

    agent_id: Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]
    title: Title | None = None
    task_id: uuid.UUID | None = None
    collection_id: uuid.UUID | None = None
    user_name: str | None = None
    """替谁开这段对话。持 ``users:act_as`` 的 API key 按它定属主；其余钥匙照旧记在
    自己名下；浏览器会话只能写自己的用户名。"""

    same_as: uuid.UUID | None = None
    """做同款的源对话 id（资料库卡的 id）。给了就在建对话时把源的 ``treatment.md``、
    ``film.icml``（改名 ``old_film.icml``）、``film.icrun``、``video_shot.json``（改名
    ``old_video_shot.json``）有的拷进来，连同整份素材台账；不拷历史，也不记血缘。源看不见是
    404，源既没有 ``film.icml`` 也没有 ``video_shot.json`` 是 422；带同一个 ``id`` 重发不再拷。"""


class ConversationForkIn(CamelModel):
    """从源对话的第 ``turn`` 轮分叉出一段新对话，归调用者所有。

    对话 id 由服务端铸：分叉先把工作区与素材拷进新命名空间，最后才落对话行，没有可供幂等
    重放的位置。出片记录不拷，副本按血缘继承。
    """

    turn: Annotated[int, Field(ge=1)]
    """从源对话的第几轮分叉，从 1 数。这一轮包含在副本里。"""

    title: Title | None = None
    """副本的名字。不给就沿用源标题加个后缀。"""

    agent_id: Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)] | None = None
    """副本用哪个 Agent 跑。不给就沿用源对话的，给了就换一个，用于对照试跑。"""

    collection_id: uuid.UUID | None = None
    """把副本直接放进自己的某个合集。源对话的合集不会带过来。"""


class ConversationRename(CamelModel):
    title: Title


class ConversationCollectionIn(CamelModel):
    """把这段对话放进某个合集，或者拿出来（给 ``null``）。

    单独一个端点而不是并进改名那个 PATCH：那样「没给这个字段」和「要清空它」在 JSON
    里长得一样，分不出来。
    """

    collection_id: uuid.UUID | None


class ConversationTaskIn(CamelModel):
    """把这段对话记在某张需求单下，或者摘掉（给 ``null``）。理由同上，单独一个端点。"""

    task_id: uuid.UUID | None


class ConversationCompletionIn(CamelModel):
    """标记这段对话收尾了，或者取消（给 ``false``）。与两处归属同理，单独一个端点。"""

    completed: bool


class ConversationActivityOut(CamelModel):
    """这段对话此刻在忙什么。侧栏据此画角标。

    嵌套一层而不是把字段平铺到行上：这一组事实还会长，平铺的话每加一个都要在行上再开一个
    顶层字段。
    """

    busy: bool
    pending_interaction: Literal["none", "approval", "question"]
    last_turn_reason: Literal["completed", "failed", "aborted"] | None = None
    video_generation: Literal["none", "queued", "running"]
    """还没跑完的视频出片到哪一步；与轮次是否在跑互不蕴含。"""


class ConversationOut(CamelModel):
    id: uuid.UUID
    owner_user_id: uuid.UUID
    """谁的对话。治理者的审计视图要看得出这一点，所以对外发。"""
    agent_id: str
    title: str
    last_run_id: str | None
    task_id: uuid.UUID | None
    collection_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    """属主删掉它的时刻。只有治理者审计带 ``deleted`` 筛选时才会见到非空值。"""
    completed_at: datetime | None
    """属主标记这活儿收尾的时刻；没标过为空。属主再动手会被抹回空。"""
    forked_from: uuid.UUID | None
    """从哪段对话分叉来的；不是分叉来的为空。前端据此画血缘提示。"""
    fork_turn: int | None
    """分叉自源对话的第几轮，从 1 数。与 ``forkedFrom`` 同时有值。"""
    activity: ConversationActivityOut
    last_seq: int
    """读这一行之前，这段对话已发出的最大会话事件序号（WebSocket 全局帧信封上的 ``seq``）。

    行里的字段至少与序号不大于它的事件一样新；客户端收到序号更大的事件帧时，以帧上的值为准。"""
    event_epoch: str
    """``lastSeq`` 所属的服务进程；与帧信封的 ``epoch`` 不同时两者不可比，以这一行为准。"""


class ConversationEnvelope(CamelModel):
    conversation: ConversationOut


class ConversationsPageOut(CamelModel):
    items: list[ConversationOut]


class ConversationPageOut(CamelModel):
    """一页对话。``nextCursor`` 为空即没有更多了；往下滑加载更多时原样回传它。"""

    items: list[ConversationOut]
    next_cursor: str | None


class SidebarCollectionOut(CamelModel):
    """侧栏里的一个合集：元信息、里面一共几段，加第一页对话。

    ``conversationCount`` 是全部条数，``page`` 只有第一页——往下滑要更多是另一次查询。
    """

    id: uuid.UUID
    name: str
    updated_at: datetime
    conversation_count: int
    page: ConversationPageOut


class SidebarOut(CamelModel):
    """侧栏拓扑：合集分组 + 没归类的对话。首屏一次拿全，前端不再自己拼。

    两个数字都是真总数（不是这一页几条）：``ungroupedCount`` 与每个合集的
    ``conversationCount``。
    """

    collections: list[SidebarCollectionOut]
    ungrouped_count: int
    ungrouped: ConversationPageOut


class ConversationsAuditItemOut(ConversationOut):
    """审计列表里的一段对话。

    ``latestMasterUrl`` 是这段对话自己名下最新完成的一条成片（出片或合成）的地址，不含分叉继承来的；
    没有成片为 null。
    """

    latest_master_url: str | None


class ConversationsAuditOut(CamelModel):
    """审计列表。``nextCursor`` 为空表示没有更多了。

    两个数字都是真总数，不随翻页变：``total`` 是当前筛选下一共几段，``runningTotal`` 是同一组
    属主 / 需求单 / 时间筛选下此刻在跑的几段（不受 ``state`` 影响）。
    """

    items: list[ConversationsAuditItemOut]
    next_cursor: str | None
    total: int
    running_total: int


class ConversationFileOut(CamelModel):
    """agent 在这段对话里写下的一个文件的元信息。``version`` 变了内容才变，前端据此决定要不要重读。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


class ConversationFilesOut(CamelModel):
    files: list[ConversationFileOut]


class ConversationFileContentOut(CamelModel):
    path: str
    content: str
    version: int


class ConversationFileWriteIn(CamelModel):
    """整份覆盖工作区里的一个文件。

    ``expectedVersion`` 是读到那一份的版本号：agent 与用户会同时写同一份文件，对不上
    就是 409，让调用方重读再决定，而不是把别人刚写的盖掉。
    """

    path: Annotated[str, Field(min_length=1)]
    content: str
    expected_version: int


class ConversationFileEnvelope(CamelModel):
    file: ConversationFileContentOut


MAX_FILM_EDITS: Final = 64
"""一次最多改几段字：页面自动保存时一次只送改过的那几段。"""

MAX_FILM_REFERENCES: Final = 10
"""按描述再生成时最多几张参考图，与生成域的图片参考图上限相同。"""

MAX_FILM_VIDEO_REFERENCES: Final = 30
"""改一段字时最多新插入几张图：一次视频请求最多 30 张参考图，再多保存检查也不会通过。"""


class FilmPromptTextOut(CamelModel):
    kind: Literal["text"] = "text"
    text: str


class FilmPromptImageOut(CamelModel):
    """描述里一张参考图所在的位置，即文件里写 ``@ImageN`` 的地方。``number`` 是它在这张图自己的
    参考图列表里的位置（即 N），``url`` 还没有选用时为 null。"""

    kind: Literal["image"] = "image"
    node: str
    label: str
    url: str | None
    number: int


FilmPromptRunOut = Annotated[FilmPromptTextOut | FilmPromptImageOut, Field(discriminator="kind")]


class FilmFrameOut(CamelModel):
    """镜头组里的一张图：先是这组视频参考图列表里的，按列表先后；再是这组镜头里还没进列表的机位图，
    按镜头先后。``node`` 是换图时传回的定位；``number`` 是它在列表里的位置，即 @N，没进列表的为
    null；``url`` 没有图时为 null。

    ``prompt`` 是按描述生成时发给模型的描述，按 ``@ImageN`` 拆成文字段和图片段，没有图的参考图
    也拆出来；``aspectRatio`` 是文件里写的画幅。用户给的图这两个都是 null。``missing`` 是这张图
    挂着、现在没有图的参考图的称呼（叫法同 ``label``），按挂的先后；不为空时这张图不能生成。用户
    给的图为空列表。"""

    node: str
    label: str
    kind: FrameKind
    url: str | None
    number: int | None
    prompt: list[FilmPromptRunOut] | None
    aspect_ratio: str | None
    missing: list[str]


class FilmSettingOut(CamelModel):
    """全局设定的一段。``target`` 为 null 的这段不能在页面上改；``label`` 是模板里这个槽的段名；
    ``images`` 恒为空列表，这组的图都在 ``frames`` 里。"""

    kind: SettingKind
    target: str | None
    label: str | None
    text: str
    images: list[str]


class FilmLineOut(CamelModel):
    """镜头里的一句台词。改这个镜头时用 ``target`` 指明是原有的哪一句。"""

    target: str
    role: str
    text: str


class FilmShotOut(CamelModel):
    """一个镜头。``parts`` 比 ``lines`` 多一段，第 i 句台词夹在第 i 段与第 i+1 段之间；
    ``target`` 为 null 的镜头不能在页面上改。"""

    target: str | None
    start: float
    end: float
    parts: list[str]
    lines: list[FilmLineOut]
    view: str | None


class FilmGroupOut(CamelModel):
    """一个镜头组。``prompt`` 是这组发给视频模型的正文，与出片时发的逐字相同；缺图时照样给出。"""

    index: int
    video: str
    model: str
    seconds: int
    aspect_ratio: str
    frames: list[FilmFrameOut]
    settings: list[FilmSettingOut]
    shots: list[FilmShotOut]
    prompt: str


class FilmViewOut(CamelModel):
    """制作页。``problems`` 不为 0 时 ``groups`` 为空：分镜正在改，等 AI 导演改好。"""

    film_version: int
    run_version: int | None
    problems: int
    groups: list[FilmGroupOut]


class FilmViewEnvelope(CamelModel):
    film: FilmViewOut


class FilmLineEditIn(CamelModel):
    """改好的一句台词的字；``target`` 照读到的原样传回。"""

    target: Annotated[str, Field(min_length=1)]
    text: str


class FilmTextEditIn(CamelModel):
    """改一段字。镜头给 ``parts`` 与 ``lines``：这一镜的每句台词按原来的先后列全，``parts`` 比它
    多一段，台词只改字；其余给 ``text``。"""

    target: Annotated[str, Field(min_length=1)]
    text: str | None = None
    parts: list[str] | None = None
    lines: list[FilmLineEditIn] | None = None
    images: Annotated[
        list[str], Field(default_factory=list[str], max_length=MAX_FILM_VIDEO_REFERENCES)
    ]
    """新插入的图：列表现有 M 张时，字里的 ``@Image(M+1)`` 起依次指这里的每一张。"""

    @field_validator("images")
    @classmethod
    def _http(cls, urls: list[str]) -> list[str]:
        if not all(is_http_url(url) for url in urls):
            raise ValueError("要写带主机名的 http(s) 地址")
        return urls

    @model_validator(mode="after")
    def _one_of(self) -> FilmTextEditIn:
        shot = (self.parts is not None, self.lines is not None)
        if self.text is not None and any(shot):
            raise ValueError("镜头给 parts 与 lines，其余给 text，不能都给")
        if self.text is None and not all(shot):
            raise ValueError("镜头要同时给 parts 与 lines，其余给 text")
        return self


class FilmTextEditsIn(CamelModel):
    """``filmVersion`` 是读到的工程文件版本号，对不上是 409。"""

    film_version: int
    edits: Annotated[list[FilmTextEditIn], Field(min_length=1, max_length=MAX_FILM_EDITS)]


class FilmImageChoiceIn(CamelModel):
    """给 ``node`` 换成 ``url``；``url`` 为 null 是取消生成图的选用，这张图就没有图了。

    两个版本号都按读到的给，没有运行文件时 ``runVersion`` 为 null。"""

    node: Annotated[str, Field(min_length=1)]
    url: str | None
    film_version: int
    run_version: int | None

    @field_validator("url")
    @classmethod
    def _http(cls, value: str | None) -> str | None:
        if value is not None and not is_http_url(value):
            raise ValueError("要写带主机名的 http(s) 地址")
        return value


class FilmImagePromptIn(CamelModel):
    """编辑器里改过的描述与参考图，只用这一次。"""

    text: Annotated[str, Field(min_length=1)]
    reference_image_urls: Annotated[list[str], Field(max_length=MAX_FILM_REFERENCES)]

    @field_validator("reference_image_urls")
    @classmethod
    def _http(cls, urls: list[str]) -> list[str]:
        if not all(is_http_url(url) for url in urls):
            raise ValueError("要写带主机名的 http(s) 地址")
        return urls


class FilmImageGenerationIn(CamelModel):
    """按描述给 ``node`` 出一张新的。``prompt`` 不给就用文件里的描述；模型按文件里写的，不收。"""

    node: Annotated[str, Field(min_length=1)]
    prompt: FilmImagePromptIn | None = None
    film_version: int
    run_version: int | None


class FilmVideoGenerationIn(CamelModel):
    """给 ``video`` 这一组出片。模型、清晰度、声音是出片栏上这次选的，不写回文件。"""

    video: Annotated[str, Field(min_length=1)]
    model: Annotated[str, Field(min_length=1)]
    resolution: Annotated[str, Field(min_length=1, max_length=50)]
    generate_audio: bool
    film_version: int
    run_version: int | None


class FilmJobOut(CamelModel):
    """受理了的生成任务；进度照常看生成记录与 ``generation.changed`` 帧。"""

    job_id: uuid.UUID


def film_image_prompt(body: FilmImageGenerationIn) -> FilmImagePrompt | None:
    if body.prompt is None:
        return None
    return FilmImagePrompt(body.prompt.text, tuple(body.prompt.reference_image_urls))


def _prompt_run_out(run: FilmPromptRun) -> FilmPromptTextOut | FilmPromptImageOut:
    if isinstance(run, FilmPromptText):
        return FilmPromptTextOut(text=run.text)
    assert isinstance(run, FilmPromptImage)
    return FilmPromptImageOut(node=run.node, label=run.label, url=run.url, number=run.number)


def film_text_edits(body: FilmTextEditsIn) -> list[FilmTextEdit]:
    return [
        FilmTextEdit(
            target=edit.target,
            text=edit.text,
            parts=None if edit.parts is None else tuple(edit.parts),
            lines=None
            if edit.lines is None
            else tuple(FilmLineEdit(line.target, line.text) for line in edit.lines),
            images=tuple(edit.images),
        )
        for edit in body.edits
    ]


def film_view_out(view: FilmView) -> FilmViewEnvelope:
    return FilmViewEnvelope(
        film=FilmViewOut(
            film_version=view.film_version,
            run_version=view.run_version,
            problems=view.problems,
            groups=[
                FilmGroupOut(
                    index=group.index,
                    video=group.video,
                    model=group.model,
                    seconds=group.seconds,
                    aspect_ratio=group.aspect_ratio,
                    frames=[
                        FilmFrameOut(
                            node=frame.node,
                            label=frame.label,
                            kind=frame.kind,
                            url=frame.url,
                            number=frame.number,
                            prompt=None
                            if frame.prompt is None
                            else [_prompt_run_out(run) for run in frame.prompt],
                            aspect_ratio=frame.aspect_ratio,
                            missing=list(frame.missing),
                        )
                        for frame in group.frames
                    ],
                    settings=[
                        FilmSettingOut(
                            kind=setting.kind,
                            target=setting.target,
                            label=setting.label,
                            text=setting.text,
                            images=list(setting.images),
                        )
                        for setting in group.settings
                    ],
                    shots=[
                        FilmShotOut(
                            target=shot.target,
                            start=shot.start,
                            end=shot.end,
                            parts=list(shot.parts),
                            lines=[
                                FilmLineOut(target=line.target, role=line.role, text=line.text)
                                for line in shot.lines
                            ],
                            view=shot.view,
                        )
                        for shot in group.shots
                    ],
                    prompt=group.prompt,
                )
                for group in view.groups
            ],
        )
    )


def conversation_out(
    conversation: Conversation, activity: ConversationActivity, events: EventWatermark
) -> ConversationOut:
    """合并对话记录、引擎提供的活动投影与读行之前取的事件水位，转换为响应模型。"""

    return ConversationOut(
        id=conversation.id,
        owner_user_id=conversation.owner_user_id,
        agent_id=conversation.agent_id,
        title=conversation.title,
        last_run_id=conversation.last_run_id,
        task_id=conversation.task_id,
        collection_id=conversation.collection_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        deleted_at=conversation.deleted_at,
        completed_at=conversation.completed_at,
        forked_from=conversation.forked_from,
        fork_turn=conversation.fork_turn,
        activity=ConversationActivityOut(
            busy=activity.busy,
            pending_interaction=activity.pending_interaction,
            last_turn_reason=activity.last_turn_reason,
            video_generation=activity.video_generation,
        ),
        last_seq=events.seq_of(conversation.id),
        event_epoch=events.epoch,
    )


def audit_item_out(
    conversation: Conversation,
    activity: ConversationActivity,
    latest_master_url: str | None,
    events: EventWatermark,
) -> ConversationsAuditItemOut:
    """在 ``conversation_out`` 之上补这段对话自己最新一条成片的地址，转换为审计列表的条目。"""

    return ConversationsAuditItemOut(
        **dict(conversation_out(conversation, activity, events)),
        latest_master_url=latest_master_url,
    )


__all__ = [
    "DEFAULT_TITLE",
    "MAX_AGENT_ID_CHARS",
    "MAX_TITLE_CHARS",
    "ConversationActivityOut",
    "ConversationAgentsOut",
    "ConversationCollectionIn",
    "ConversationEnvelope",
    "ConversationFileContentOut",
    "ConversationFileEnvelope",
    "ConversationFileOut",
    "ConversationFileWriteIn",
    "ConversationFilesOut",
    "ConversationForkIn",
    "ConversationIn",
    "ConversationOut",
    "ConversationPageOut",
    "ConversationRename",
    "ConversationTaskIn",
    "ConversationsAuditItemOut",
    "ConversationsAuditOut",
    "ConversationsPageOut",
    "SidebarCollectionOut",
    "SidebarOut",
    "audit_item_out",
    "conversation_out",
]
