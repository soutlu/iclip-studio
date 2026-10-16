"""生成请求的 HTTP 与持久化类型定义。

落库的请求有六种形状：视频（出片与编辑段）照抄上游异步接口（snake_case），图片、合成、整片、字幕
识别与生成背景音乐是本系统自己的（camelCase）。持久化存的就是请求自己的字段名，读取时按
(kind, operation) 经 request_from_payload 重新校验，非法数据直接报错；合成与整片同是 video /
compose，按请求里有没有 ``subtitles`` 分开。编辑段、合成、整片、手动识别字幕与生成背景音乐的受理
输入另有自己的类型，受理时换成落库的那一种。切图与上传没有请求。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Final, Literal, get_args, overload

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    StringConstraints,
    Tag,
    TypeAdapter,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from iclip.common.errors import ValidationFailed
from iclip.common.generation_vocab import GenerationKind, GenerationOperation, GenerationStatus
from iclip.common.shot_prompt import format_seconds, format_shot_prompt
from iclip.common.shot_rules import (
    MAX_REFERENCE_IMAGES,
    first_unavailable_image,
    image_indexes_of,
    timeline_fault,
)
from iclip.common.urls import is_http_url

if TYPE_CHECKING:  # 只为类型：真导入会和 models.py 成环
    from iclip.domains.generation.models import GenerationJob

# 两套词表写在 common（推送帧也要引），这里照原名导出。状态常量放这里而不是 models.py：
# GenerationOut 运行时要解析状态词，本模块的投影要按它判断，而 models.py 反过来导入本模块。
STATUS_PENDING: Final = "pending"
"""已受理，尚未提交给 Provider。"""
STATUS_SUBMITTING: Final = "submitting"
"""提交中断时禁止自动重投，避免重复计费；恢复规则见 queue.py。"""
STATUS_SUBMITTED: Final = "submitted"
"""Provider 已接受任务，等待结果。"""
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

KIND_VIDEO: Final = "video"
KIND_IMAGE: Final = "image"
KIND_SUBTITLE: Final = "subtitle"
"""字幕记录：识别一条成片的口播，结果是逐句文字与时间，不是媒体地址。"""
KIND_AUDIO: Final = "audio"
"""音频记录：用户上传的音乐（upload），或生成的背景音乐（generate）。"""

OPERATION_GENERATE: Final = "generate"
"""调模型：出片、编辑段、图片生成都是它。"""
OPERATION_COMPOSE: Final = "compose"
"""本地拼接：合成出一条新的成片，不经外部服务。"""
OPERATION_CUT: Final = "cut"
"""本地切图：从一张宫格上切出来的一格，来源是那张宫格。创建即完成，没有请求。"""
OPERATION_UPLOAD: Final = "upload"
"""用户上传：确认过的一次直传，没有来源、不挂对话。创建即完成，没有请求。"""

ClipStage = Literal["fetching", "processing", "uploading"]
"""本地加工（合成）在途时跑到哪一步，加工时上报，落在 provider_status 上。编辑段没有本地加工。

排队由 ``status == "pending"`` 表达，终态由 status 表达，都不另给词。"""

CLIP_FETCHING: Final = "fetching"
"""取素材：下载各段的源，以及探它们的规格。"""
CLIP_PROCESSING: Final = "processing"
"""加工：拼起来重编码。"""
CLIP_UPLOADING: Final = "uploading"
"""上传：把产物交给对象存储。"""

CLIP_STAGES: Final[tuple[ClipStage, ...]] = get_args(ClipStage)
"""能对外露出的阶段词。列里出现别的值就当没有，不把任意 provider 状态转给调用方。"""

IMAGE_ASPECT_RATIOS = Literal[
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]
IMAGE_RESOLUTIONS = Literal["1k", "2k", "4k"]

IMAGE_MAX_REFERENCES: Final = 10
"""图像编辑接口的参考图上限。超了在提交之前就拒，不浪费一次付费调用。"""
MAX_PROMPT_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = MAX_REFERENCE_IMAGES
"""每类参考素材最多几个地址，取一组镜头的帧图上限：分镜文件里存得下的一组，出片就必须发得出去。"""
MAX_MODEL_CHARS: Final = 200
MAX_USER_NAME_CHARS: Final = 200
MAX_METADATA_CHARS: Final = 2000
"""``metadata`` 序列化后的长度上限：它是调用方的坐标标签，不是存东西的地方。"""
MAX_URL_CHARS: Final = 2000
"""服务端要拿去下载的单个地址的长度上限。"""
MAX_COMPOSE_SEGMENTS: Final = 100
"""一次合成最多几段。每段在 ffmpeg 里是一路输入，列表又由调用方给，不设上限就能拿一个请求把
合成机占满；按关键帧分段，30 秒的片几十段已足够。"""

ORIGIN_FIELDS: Final = frozenset(
    {"conversation_id", "task_id", "metadata", "shot_index", "source_url"}
)
"""归属字段：落表上自己的列，不进 ``request`` JSON。

它们不是发给 provider 的参数，而是「这一行属于谁、为谁出的」：对话与需求单按索引查；视频的
镜头组编号落 ``shot_index`` 列；``metadata`` 是调用方自己的键，服务端不读不写、原样存、按包含
匹配筛。帧图编辑的 ``source_url``（底图地址）是请求字段，受理时解析成来源；编辑段的基底与区间
由它的受理输入给，核对后落列；原作不是请求字段，由服务端按基底定。"""

NOT_FORWARDED_FIELDS: Final = ORIGIN_FIELDS | frozenset({"shot"})
"""发给上游时去掉的字段：归属字段是我们自己的；``shot`` 已经拼成 ``prompt``，上游只认正文。
``shot`` 与归属字段不同，它要留在 ``request`` JSON 里给前端回填，所以不能进 ORIGIN_FIELDS。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SnakeModel(BaseModel):
    """字段名原样：视频那一对端点是上游接口的镜像，不转 camelCase。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


Prompt = Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]
ModelName = Annotated[str, Field(min_length=1, max_length=MAX_MODEL_CHARS)]
UserName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS)
]
"""上游对账用的归属标签。它不是身份，不参与授权；取值规则在 identity 的 resolve_user_name。"""

MediaUrls = Annotated[list[str], Field(max_length=MAX_REFERENCE_URLS)]
"""一串媒体 URL。只收 http(s)：这些地址会被 provider 拿去下载，放行 ``file://``
之类的 scheme 等于把服务端变成任意文件的读取入口。"""


def _http_only(urls: list[str]) -> list[str]:
    for index, url in enumerate(urls):
        if not is_http_url(url):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


def _bounded_metadata(value: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(value, ensure_ascii=False, default=str)) > MAX_METADATA_CHARS:
        raise ValueError(f"metadata 序列化后不能超过 {MAX_METADATA_CHARS} 字符")
    return value


Metadata = Annotated[dict[str, Any], AfterValidator(_bounded_metadata)]
"""调用方自己的键，形状归调用方定（分镜页给图片记 ``{"shot", "frame"}``）；服务端不读不写、
不校验，只拦超长。视频的镜号在 ``shot_index``，不在这里。"""


def _nonblank(text: str) -> str:
    """只拒全空白，不改写：正文里的空格与换行会原样进拼出来的提示词。"""

    if not text.strip():
        raise ValueError("不能是空白")
    return text


Seconds = Annotated[float, Field(ge=0)]


class VideoShotTimelineItemIn(SnakeModel):
    """镜头组里的一镜：起止时间、说什么、引了哪几张图。与分镜文件 video_shot.json 里的一镜同形。"""

    timestamps: tuple[Seconds, Seconds]
    """``[开始秒, 结束秒]``，正文里的镜头标记直接用它，不重算。"""
    prompt: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]
    image_indexes: list[Annotated[int, Field(ge=1)]]
    """正文里 ``@ImageN`` 的编号，按首次出现顺序；与分镜交付物里的同名字段是同一份。"""

    _check_prompt = field_validator("prompt")(_nonblank)

    @model_validator(mode="after")
    def _indexes_follow_the_prompt(self) -> VideoShotTimelineItemIn:
        derived = image_indexes_of(self.prompt)
        if self.image_indexes != derived:
            raise ValueError(
                f"image_indexes {self.image_indexes} 与正文里 @Image 的出现顺序 {derived} 不一致"
            )
        return self


class VideoShotIn(SnakeModel):
    """结构化的镜头组：全局设定加逐镜时间线。发给模型的正文由服务端按 common.shot_prompt 的规则拼。"""

    global_settings: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]
    timeline: Annotated[list[VideoShotTimelineItemIn], Field(min_length=1)]

    _check_global_settings = field_validator("global_settings")(_nonblank)

    @model_validator(mode="after")
    def _timeline_runs_forward(self) -> VideoShotIn:
        """与分镜交付同一套规则：第一镜从 0 起，每镜结束晚于开始，各镜按先后排、不重叠。"""

        previous_end = 0.0
        for position, item in enumerate(self.timeline, start=1):
            start, end = item.timestamps
            match timeline_fault(position, start, end, previous_end):
                case "not_after_start":
                    raise ValueError(
                        f"第 {position} 镜的 timestamps 为 [{format_seconds(start)}, "
                        f"{format_seconds(end)}]，结束必须晚于开始"
                    )
                case "first_not_at_zero":
                    raise ValueError(f"第一镜从 {format_seconds(start)} 秒开始，必须从 0 开始")
                case "overlaps_previous":
                    raise ValueError(
                        f"第 {position} 镜从 {format_seconds(start)} 秒开始，"
                        f"早于上一镜的结束 {format_seconds(previous_end)} 秒"
                    )
                case None:
                    previous_end = end
        return self


def _check_image_references(shot: VideoShotIn, available: int) -> None:
    """``@ImageN`` 指的是 reference_image_urls 的第 N 张；编号越界说明图和正文对不上。"""

    texts = [("global_settings", shot.global_settings)]
    texts += [
        (f"timeline[{index}].prompt", item.prompt) for index, item in enumerate(shot.timeline)
    ]
    for where, text in texts:
        number = first_unavailable_image(text, available)
        if number is not None:
            raise ValueError(
                f"shot.{where} 引用了 @Image{number}，但 reference_image_urls 只有 {available} 张"
            )


_READ_BACK: Final = "read_back"
"""校验上下文里的键：值为 True 表示在读回持久化记录，不是受理新请求。只有 ``request_from_payload`` 带它。"""


class VideoGenerationIn(SnakeModel):
    """一次视频生成的输入。字段照上游异步接口，外加归属字段、坐标 ``metadata`` 与结构化的 ``shot``。

    只拦本系统能判的：模型在允许表里（受理层）、地址是 http(s)、秒数不小于 -1、``shot``
    自身对得上（图片引用不越界、编号与正文一致）。画幅、分辨率、时长范围、素材规格由上游
    按模型判，这里不复制一份。
    """

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    model: ModelName
    """新请求只接受配置允许的视频模型。历史记录保留原模型字符串，读回时不套用当前允许表。"""
    prompt: Prompt | None = None
    """发给模型的正文。传了 ``shot`` 可以不传，由服务端拼出来；两个都传时必须一字不差。"""
    shot: VideoShotIn | None = None
    """结构化的镜头组。存进记录供前端回填，不发上游——上游只认拼好的 ``prompt``。"""
    user_name: UserName | None = None
    """替谁发的。HTTP 边界按主体定值（API key 必填、浏览器填登录名），受理时已经非空。"""
    reference_image_urls: MediaUrls = []
    reference_video_urls: MediaUrls = []
    reference_audio_urls: MediaUrls = []
    generate_audio: bool | None = None
    """不传就不转发，让上游用模型默认；显式 False 保持关闭。"""
    resolution: Annotated[str, Field(min_length=1, max_length=50)] | None = None
    aspect_ratio: Annotated[str, Field(min_length=1, max_length=20)] | None = None
    seconds: Annotated[int, Field(ge=-1)] | None = None
    """``0`` 与 ``-1`` 的含义由上游定：默认时长、模型自定。"""
    provider_options: dict[str, Any] | None = None
    """各家私有参数的透传口，白名单由上游校验。"""

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    """需求单 id。只做归属与筛选，不校验它与对话的挂载关系。"""
    metadata: Metadata | None = None
    shot_index: Annotated[int, Field(ge=1)] | None = None
    """镜头组编号，从 1 起。落记录自己的列，不进 ``request``、不发上游；不给就是一条没有镜号的出片。

    下界跟着分镜文件走：那里的 ``shots[].index`` 就是从 1 数的。收下 0 只会落一条读不出
    镜头组的记录——服务端不报错，分镜页永远不显示。"""

    _check_urls = field_validator(
        "reference_image_urls", "reference_video_urls", "reference_audio_urls"
    )(_http_only)

    @model_validator(mode="after")
    def _assemble_prompt_from_shot(self, info: ValidationInfo) -> VideoGenerationIn:
        """受理时 prompt 与 shot 至少给一个，只给 shot 由服务端拼出 prompt，两个都给就得一字不差。

        读回持久化记录（``request_from_payload`` 带上读回标记）时以存下来的 prompt 为准：它是当时
        实际发出去的正文，拼法后来改过，按现行拼法重拼会与它对不上，所以不重拼、不比对。"""

        if self.shot is None:
            if self.prompt is None:
                raise ValueError("prompt 与 shot 至少传一个")
            return self
        _check_image_references(self.shot, len(self.reference_image_urls))
        if isinstance(info.context, dict) and info.context.get(_READ_BACK) is True:
            if self.prompt is None:
                raise ValueError("记录里有 shot 却没有 prompt")
            return self
        assembled = format_shot_prompt(self.shot)
        if len(assembled) > MAX_PROMPT_CHARS:
            raise ValueError(
                f"shot 拼出的正文有 {len(assembled)} 字，超过 {MAX_PROMPT_CHARS} 字上限"
            )
        if self.prompt is not None and self.prompt != assembled:
            raise ValueError("prompt 与 shot 拼出的正文不一致，二者只传一个")
        # 模型是 frozen 的，校验器又不能换掉 self，派生字段只能这样填进去。
        object.__setattr__(self, "prompt", assembled)
        return self


class ImageGenerationIn(CamelModel):
    """一次图像生成的输入。参考图为空即文生图，否则走图像编辑。"""

    kind: ClassVar[GenerationKind] = KIND_IMAGE
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    prompt: Prompt
    user_name: UserName | None = None
    """替谁发的。HTTP 边界按主体定值，工具从运行依赖取；受理时已经非空。"""
    model: ModelName | None = None
    """要哪家图片模型。省略时在受理阶段填入配置的默认模型。

    可选集合是装配表里那几家，不是一份枚举——运行配置声明接入了谁，能力清单端点照
    同一份声明对外说明。历史记录保留原模型字符串，读取持久化请求时不套用当前的选择策略。"""
    channel: Literal["dev", "pro"] | None = None
    """走哪个渠道。**只对声明了渠道轴的那几家有意义**，给别家会在受理阶段被拒。

    有渠道轴的那家两个渠道价钱不一样，所以这是调用方的决定，不是我们能替他换的；
    省略时受理阶段按那家声明的默认渠道填。"""
    aspect_ratio: IMAGE_ASPECT_RATIOS
    resolution: IMAGE_RESOLUTIONS = "1k"
    reference_image_urls: Annotated[list[str], Field(max_length=IMAGE_MAX_REFERENCES)] = []

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None
    source_url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)] | None = None
    """帧图编辑的底图地址：这次改的是哪张图。受理时按地址找库里的记录，找到记来源、找不到记外部
    地址；不进 ``request``、不发上游（底图要不要给模型看，由 ``referenceImageUrls`` 决定）。"""

    _check_urls = field_validator("reference_image_urls")(_http_only)

    @field_validator("source_url")
    @classmethod
    def _source_is_http(cls, url: str | None) -> str | None:
        if url is not None and not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class VideoEditIn(SnakeModel):
    """一次编辑段的受理输入：一次上游视频请求，外加只记账的替换基底与区间。

    转发给上游的字段照上游命名，参考视频恰好一条：调用方按当前选用素材裁剪、拼接后上传的
    参考片段，时长不必等于基底替换区间。
    ``source_job_id`` 与 ``range_start_ms`` / ``range_end_ms`` 只记账、不参与处理，有了它们这条
    记录才是编辑段。不收 ``shot`` 与原作：编辑段只有正文，原作由基底定。受理后落库的是一条
    ``VideoGenerationIn``，来源、原作与区间落列。"""

    source_job_id: uuid.UUID
    """替换基底：一条已完成的成片（出片或合成），这段对话自己的或继承来的。"""
    range_start_ms: Annotated[int, Field(ge=0)]
    range_end_ms: int
    """产物将替换基底上的那一段，毫秒，原样记下；要在基底时长内，独立于实际参考片段时长。"""
    reference_video_urls: Annotated[list[str], Field(min_length=1, max_length=1)]
    """实际模型参考的地址：调用者本人上传的一条可读、有正时长的视频。"""
    model: ModelName
    prompt: Prompt
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""
    reference_image_urls: MediaUrls = []
    seconds: Annotated[int, Field(ge=-1)] | None = None
    provider_options: dict[str, Any] | None = None

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None

    _check_urls = field_validator("reference_image_urls", "reference_video_urls")(_http_only)

    @model_validator(mode="after")
    def _end_after_start(self) -> VideoEditIn:
        if self.range_end_ms <= self.range_start_ms:
            raise ValueError("range_end_ms 必须大于 range_start_ms")
        return self


class ComposeSegmentIn(CamelModel):
    """合成里的一段：从 ``sourceJobId`` 那条记录的产物上取 ``[start, end)``，单位秒，按那条记录
    自己的媒体时间算；``end`` 为空就取到那条的结尾。"""

    source_job_id: uuid.UUID
    """这一段出自哪条记录：基底本身，或来源是基底的一条已完成编辑段。"""
    start: float = Field(ge=0)
    end: float | None = None
    """开放的结尾由执行方按下载下来的素材时长补齐：那条记录的时长受理时不一定知道。"""

    @model_validator(mode="after")
    def _end_after_start(self) -> ComposeSegmentIn:
        if self.end is not None and self.end <= self.start:
            raise ValueError("end 必须大于 start")
        return self


class VideoComposeIn(CamelModel):
    """一次合成的受理输入：基底那一版加一串有序片段，服务端核对各段出处后换成地址再拼。"""

    base_job_id: uuid.UUID
    """基底：一条已完成的成片（出片或合成），这段对话自己的或继承来的。合成的来源记它。"""
    segments: Annotated[
        list[ComposeSegmentIn], Field(min_length=1, max_length=MAX_COMPOSE_SEGMENTS)
    ]
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None


class ComposeSegment(ComposeSegmentIn):
    """落库的一段：受理时由服务端把 ``source_job_id`` 换成那条记录的产物地址 ``url``，两者都存；
    执行方只读地址与起止。"""

    url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]

    @field_validator("url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class VideoComposeRequest(CamelModel):
    """一次合成交给本地执行方的输入：按顺序取各段拼成一条，一律重编码对齐到原片。

    各段的出处由调用方给，地址由服务端按出处填，不收调用方给的地址。``user_name`` 只作对账标签。"""

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_COMPOSE

    segments: Annotated[list[ComposeSegment], Field(min_length=1)]
    user_name: UserName | None = None


MAX_WHOLE_FILM_MS: Final = 120_000
"""整片最长多少毫秒（片头、各段与片尾的时长之和）。整片时间上的字段（字幕起止、音量曲线的时刻）
都以它为上限，合同里能读到这个数。"""
MAX_WHOLE_FILM_SUBTITLES: Final = 500
"""一条整片最多几句字幕：120 秒里一句平均不到 0.25 秒，足够；字幕文件由服务端写，不设上限就能拿
一个请求造出任意大的文件。"""
MAX_WHOLE_FILM_SUBTITLE_CHARS: Final = 200
"""一句字幕最多几个字。烧进画面的一句话，两三行已经很满。"""
MAX_MUSIC_GAIN_POINTS: Final = 500
"""音量曲线最多几个点。曲线要写进一条 ffmpeg 命令的参数里（Linux 单个参数上限 128 KB），500 个点
约 30 KB；口播一句压低一次用四个点，120 秒够用。"""

FilmMs = Annotated[int, Field(ge=0, le=MAX_WHOLE_FILM_MS)]
"""整片时间上的一个时刻，毫秒，从第一段开头算，不含片头：片头片尾上没有字幕，也不铺音乐。"""


class WholeFilmSegmentIn(CamelModel):
    """整片里的一段：从 ``sourceJobId`` 那条成片上取 ``[startMs, endMs)``，按那条成片自己的媒体时间。"""

    source_job_id: uuid.UUID
    """这一段出自哪条成片：这段对话读得到的出片或有基底的合成，不能是整片、编辑段或上传。"""
    start_ms: Annotated[int, Field(ge=0)]
    end_ms: int
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0
    """原声相对自动响度基准的线性音量；0 静音，1 保持基准。"""

    @model_validator(mode="after")
    def _end_after_start(self) -> WholeFilmSegmentIn:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs 必须大于 startMs")
        return self

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class WholeFilmSubtitle(CamelModel):
    """整片上的一句字幕：整片时间里的起止（毫秒）与烧进画面的文字，原样照用。"""

    start_ms: FilmMs
    end_ms: FilmMs
    text: Annotated[str, Field(min_length=1, max_length=MAX_WHOLE_FILM_SUBTITLE_CHARS)]

    _check_text = field_validator("text")(_nonblank)

    @model_validator(mode="after")
    def _end_after_start(self) -> WholeFilmSubtitle:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs 必须大于 startMs")
        return self


class MusicGainPoint(CamelModel):
    """音量曲线上的一个点：整片时间 ``atMs`` 处音乐的线性音量（0 静音，1 原样）。"""

    at_ms: FilmMs
    gain: Annotated[float, Field(ge=0, le=1)]


class WholeFilmMusicIn(CamelModel):
    """整片的背景音乐：用哪条音频记录、从它第几毫秒起用，以及整片时间上的音量曲线。"""

    audio_job_id: uuid.UUID
    """一条已完成的音频记录：调用者自己上传的音乐，或这段对话读得到的生成音乐。"""
    offset_ms: Annotated[int, Field(ge=0)]
    """从音乐的第几毫秒开始用；从这里起要够整片那么长。"""
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0
    """配乐相对自动响度与避让曲线基准的线性音量；0 静音，1 保持基准。"""
    gain: Annotated[list[MusicGainPoint], Field(min_length=1, max_length=MAX_MUSIC_GAIN_POINTS)]
    """按时刻严格递增；点与点之间线性插值，第一个点之前取第一个点的音量，最后一个点之后取最后一个。"""

    @field_validator("gain")
    @classmethod
    def _strictly_increasing(cls, points: list[MusicGainPoint]) -> list[MusicGainPoint]:
        for position in range(1, len(points)):
            if points[position].at_ms <= points[position - 1].at_ms:
                raise ValueError(
                    f"第 {position + 1} 个点的 atMs {points[position].at_ms} 不晚于前一个点"
                )
        return points


def _segments_ms(segments: list[WholeFilmSegmentIn]) -> int:
    return sum(segment.duration_ms for segment in segments)


class WholeFilmBrandIn(CamelModel):
    """整片的片头或片尾：用哪条品牌模板。"""

    template_id: uuid.UUID
    """一条在用的品牌模板，位置要对得上（片头用片头模板，片尾用片尾模板）。"""


class WholeFilmIn(CamelModel):
    """一条整片的受理输入：一份时间线。可选的片头在最前、片尾在最后，中间各段按顺序首尾相接；整片
    总长是三者之和，片头片尾的时长受理时按模板定。

    字幕与音乐的时间都从第一段开头算（不含片头），只覆盖各段，已由调用方算好，服务端照做。归属参数
    与别的提交端点一样，只是对话必填：整片是一段对话的。``userName`` 只用来替人办事，不进
    ``request``。"""

    segments: Annotated[
        list[WholeFilmSegmentIn], Field(min_length=1, max_length=MAX_COMPOSE_SEGMENTS)
    ]
    subtitles: Annotated[list[WholeFilmSubtitle], Field(max_length=MAX_WHOLE_FILM_SUBTITLES)]
    """按时间先后、互不重叠，都在各段之内；没有字幕给空数组。"""
    music: WholeFilmMusicIn | None = None
    font_id: uuid.UUID | None = None
    """字幕字体资源；不指定时使用系统字体。"""
    intro: WholeFilmBrandIn | None = None
    outro: WholeFilmBrandIn | None = None
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""

    conversation_id: uuid.UUID
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None

    @model_validator(mode="after")
    def _fits_the_film(self) -> WholeFilmIn:
        """各段先单独核一遍上限；连片头片尾一起的总长要等受理时读到模板才核得了。"""

        total = _segments_ms(self.segments)
        if total > MAX_WHOLE_FILM_MS:
            raise ValueError(
                f"整片一共 {format_seconds(total / 1000)} 秒，"
                f"超过 {format_seconds(MAX_WHOLE_FILM_MS / 1000)} 秒上限"
            )
        previous_end = 0
        for position, subtitle in enumerate(self.subtitles, start=1):
            if subtitle.start_ms < previous_end:
                raise ValueError(f"第 {position} 句字幕与上一句重叠，或没有按时间先后排")
            if subtitle.end_ms > total:
                raise ValueError(
                    f"第 {position} 句字幕结束在 {format_seconds(subtitle.end_ms / 1000)} 秒，"
                    f"超出了整片的 {format_seconds(total / 1000)} 秒"
                )
            previous_end = subtitle.end_ms
        if self.music is not None and self.music.gain[-1].at_ms > total:
            raise ValueError(
                f"音量曲线的最后一个点在 {format_seconds(self.music.gain[-1].at_ms / 1000)} 秒，"
                f"超出了整片的 {format_seconds(total / 1000)} 秒"
            )
        return self

    @property
    def segments_ms(self) -> int:
        """各段时长之和，毫秒：字幕与音乐所在的那一段时间有多长。"""

        return _segments_ms(self.segments)


class WholeFilmSegment(WholeFilmSegmentIn):
    """落库的一段：受理时由服务端把出处换成那条成片的产物地址 ``url``，两者都存。"""

    url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]

    @field_validator("url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class WholeFilmMusic(WholeFilmMusicIn):
    """落库的音乐：受理时由服务端把音频记录换成它的产物地址 ``url``，两者都存。"""

    url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]

    @field_validator("url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class WholeFilmBrand(CamelModel):
    """落库的片头或片尾：受理时那条品牌模板的快照。模板以后改名、停用都不影响这条整片。"""

    template_id: uuid.UUID
    url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]
    duration_ms: Annotated[int, Field(gt=0)]
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    has_audio: bool
    """建模板时量的；渲染时照样自己探一遍，没有音轨的补静音。"""

    @field_validator("url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class WholeFilmFont(CamelModel):
    """受理时选中的字幕字体及文件内属性快照；改名、停用不改变已受理的整片。"""

    font_id: uuid.UUID
    url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]
    name: Annotated[str, Field(min_length=1)]
    family: Annotated[str, Field(min_length=1)]
    weight: Annotated[int, Field(ge=1, le=1000)]
    style: Literal["normal", "italic", "oblique"]

    @field_validator("url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


SPEECH_LOUDNESS_LUFS: Final = -16.0
"""整片里每段原声统一到的响度（LUFS）：口播与移动端节目常用的 -16，与生成背景音乐规整到的响度
相同，音乐的音量曲线从同一个起点压。"""
FILM_LOUDNESS_LUFS: Final = -14.0
"""整片最后统一到的响度（LUFS）：抖音、YouTube 等短视频平台按 -14 左右做响度归一，交付就落在它
附近，上传后不会被平台再压低或拉高太多。"""
FILM_PEAK_DBFS: Final = -1.5
"""整片最后限幅的采样峰值上限（dBFS）。限幅器按采样峰值限，比常用的 -1 dBTP 再多留 0.5 dB，给
AAC 编码后的峰值抬升留余量。"""
SEGMENT_FADE_MS: Final = 50
"""每段原声两端各做多长的淡入淡出：短到听不出，足以消掉切点上的爆音。"""
MUSIC_FADE_OUT_MS: Final = 2000
"""音乐在整片结尾淡出多长。"""


class WholeFilmRender(CamelModel):
    """整片怎么做声音：受理时按当时的常量记下，执行方照记录做，常量以后改了也不影响已有的记录。

    画面不在这里：画幅与帧率取第一段那条成片，执行时才量得到；字幕的样式随执行方固定。"""

    speech_loudness_lufs: float = SPEECH_LOUDNESS_LUFS
    """每条来源先量一次整体响度，按差值把它的原声统一到这个响度。"""
    music_loudness_lufs: float = SPEECH_LOUDNESS_LUFS
    """音乐先量一次整体响度统一到这个响度，再按音量曲线调：上传的音乐没规整过，响度各不相同。"""
    loudness_lufs: float = FILM_LOUDNESS_LUFS
    """原声与音乐混好之后整片统一到的响度。"""
    peak_dbfs: float = FILM_PEAK_DBFS
    segment_fade_ms: Annotated[int, Field(ge=0)] = SEGMENT_FADE_MS
    music_fade_out_ms: Annotated[int, Field(ge=0)] = MUSIC_FADE_OUT_MS


class WholeFilmRequest(CamelModel):
    """一条整片交给本地执行方的输入：完整的时间线，加上怎么做声音。

    与合成同是 video / compose，没有来源、原作与镜号；各段与音乐的出处由调用方给，地址由服务端按
    出处填，片头片尾是受理时模板的快照。字幕与音乐的时刻从第一段开头算，渲染时按片头的时长往后挪。
    不记 ``userName``：它只用来替人办事。"""

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_COMPOSE

    segments: Annotated[list[WholeFilmSegment], Field(min_length=1)]
    subtitles: list[WholeFilmSubtitle]
    music: WholeFilmMusic | None
    render: WholeFilmRender
    font: WholeFilmFont | None = None
    """为空时使用系统字体。"""
    intro: WholeFilmBrand | None = None
    outro: WholeFilmBrand | None = None
    """片头片尾在加上它们之前落的整片里没有这两项，读回来就是没有。"""

    @property
    def segments_ms(self) -> int:
        """各段时长之和，毫秒。"""

        return sum(segment.duration_ms for segment in self.segments)

    @property
    def duration_ms(self) -> int:
        """整片总长，毫秒：片头、各段与片尾的时长之和。"""

        brands = sum(brand.duration_ms for brand in (self.intro, self.outro) if brand is not None)
        return self.segments_ms + brands


def _compose_shape(value: Any) -> str:
    """video / compose 的两种请求：整片一定带 ``subtitles``（可以是空数组），合成没有这一项。"""

    if isinstance(value, WholeFilmRequest) or (isinstance(value, dict) and "subtitles" in value):
        return "whole_film"
    return "composite"


ComposeRequest = Annotated[
    Annotated[VideoComposeRequest, Tag("composite")]
    | Annotated[WholeFilmRequest, Tag("whole_film")],
    Discriminator(_compose_shape),
]
"""video / compose 落库的请求：合成或整片。"""


class SubtitleIn(CamelModel):
    """手动识别一条成片的受理输入：补识别旧视频，或识别失败后另起一次。

    归属参数与别的提交端点一样；``userName`` 只用来替人办事（持 ``users:act_as`` 的钥匙），识别
    服务不收它，不进 ``request``。"""

    source_job_id: uuid.UUID
    """要识别的那条成片（已完成的出片或合成），这段对话自己的或继承来的。"""
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None


class SubtitleRequest(CamelModel):
    """一次字幕识别交给执行方的输入：识别哪条视频、用哪个模型、按什么参数发。

    执行方下载 ``videoUrl``、抽成单声道 16 kHz mp3，以 Base64 发给识别服务；音频字节不落库。
    后三个字段记下随请求发出的固定参数：开说话人分离才拿得到全部句子的起止时间。"""

    kind: ClassVar[GenerationKind] = KIND_SUBTITLE
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    model: ModelName
    video_url: Annotated[str, Field(min_length=1, max_length=MAX_URL_CHARS)]
    """成片的原片地址（``outputUrl``），不用水印版。"""
    audio_format: Literal["mp3"] = "mp3"
    sample_rate: Literal[16000] = 16000
    speaker_diarization: Literal[True] = True

    @field_validator("video_url")
    @classmethod
    def _downloadable(cls, url: str) -> str:
        if not is_http_url(url):
            raise ValueError("必须是 http:// 或 https:// 地址")
        return url


class SubtitleSentence(CamelModel):
    """字幕里的一句：在视频里的起止（毫秒）、文字与说话人。落库是 snake_case 的键，对外 camelCase。"""

    start_ms: Annotated[int, Field(ge=0)]
    end_ms: Annotated[int, Field(ge=0)]
    text: str
    speaker: int | None
    """识别服务给的说话人编号，只在这一条视频里区分谁在说：不同视频里的同一个编号不是同一个人。
    服务没给就是空。"""

    @model_validator(mode="after")
    def _end_not_before_start(self) -> SubtitleSentence:
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms 不能早于 start_ms")
        return self


def sentences_to_payload(
    sentences: tuple[SubtitleSentence, ...] | None,
) -> list[dict[str, Any]] | None:
    """逐句结果的持久化 JSON：键照字段名（snake_case），没有结果原样是 ``None``。"""

    if sentences is None:
        return None
    return [sentence.model_dump() for sentence in sentences]


_SENTENCES: Final = TypeAdapter(tuple[SubtitleSentence, ...])


def sentences_from_payload(payload: Any) -> tuple[SubtitleSentence, ...] | None:
    """读回逐句结果；形状不对直接报错，不当成没有。"""

    if payload is None:
        return None
    try:
        return _SENTENCES.validate_python(payload)
    except ValueError as exc:
        raise ValidationFailed(f"字幕结果的形状不合法: {exc}") from exc


MAX_MUSIC_PROMPT_CHARS: Final = 3000
"""生成背景音乐的提示词上限：音乐模型 ``text_prompt`` 的长度上限，超了在受理时就拒。"""

MusicPrompt = Annotated[str, Field(min_length=1, max_length=MAX_MUSIC_PROMPT_CHARS)]


class MusicIn(CamelModel):
    """生成一段背景音乐的受理输入。

    ``prompt`` 原样发给音乐模型，服务端不补任何文字；音乐多长由模型决定。归属参数与别的提交端点
    一样，只是对话必填：背景音乐是给这段对话的整片用的。``userName`` 只用来替人办事，音乐模型不收
    它，不进 ``request``。"""

    prompt: MusicPrompt
    """音乐的描述：工程文件里「配乐」的原文，或用户写的一句。"""
    user_name: UserName | None = None
    """规则同出片的 ``user_name``。"""

    conversation_id: uuid.UUID
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None

    _check_prompt = field_validator("prompt")(_nonblank)


class MusicRequest(CamelModel):
    """一次生成背景音乐交给执行方的输入：用哪个模型、发出的提示词，以及向模型要的音频格式。

    执行方拿到模型给的 wav 后去掉首尾静音、统一响度，编成 m4a 存进本系统的桶；存下的格式看
    ``outputUrl``，不在这里。"""

    kind: ClassVar[GenerationKind] = KIND_AUDIO
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    model: ModelName
    prompt: MusicPrompt
    """原样发给模型的 ``text_prompt``，就是受理时收到的那一段。"""
    format: Literal["wav"] = "wav"
    sample_rate: Literal[48000] = 48000
    channels: Literal[2] = 2


GenerationRequest = (
    VideoGenerationIn
    | ImageGenerationIn
    | VideoComposeRequest
    | WholeFilmRequest
    | SubtitleRequest
    | MusicRequest
)

_ADAPTERS: Final[Mapping[tuple[str, str], TypeAdapter[Any]]] = {
    (KIND_VIDEO, OPERATION_GENERATE): TypeAdapter(VideoGenerationIn),
    (KIND_IMAGE, OPERATION_GENERATE): TypeAdapter(ImageGenerationIn),
    (KIND_VIDEO, OPERATION_COMPOSE): TypeAdapter(ComposeRequest),
    (KIND_SUBTITLE, OPERATION_GENERATE): TypeAdapter(SubtitleRequest),
    (KIND_AUDIO, OPERATION_GENERATE): TypeAdapter(MusicRequest),
}
"""编辑段落库的仍是 ``VideoGenerationIn``：它与出片的区别在来源列上，不在请求形状上。合成与整片
共用 video / compose，按 ``_compose_shape`` 分。"""

_WITHOUT_REQUEST: Final = frozenset(
    {
        (KIND_IMAGE, OPERATION_CUT),
        (KIND_IMAGE, OPERATION_UPLOAD),
        (KIND_VIDEO, OPERATION_UPLOAD),
        (KIND_AUDIO, OPERATION_UPLOAD),
    }
)
"""创建即完成、没有请求的那几种行：切图只有图片，上传图片、视频与音频都有。"""


@overload
def request_to_payload(request: GenerationRequest) -> dict[str, Any]: ...
@overload
def request_to_payload(request: None) -> None: ...
def request_to_payload(request: GenerationRequest | None) -> dict[str, Any] | None:
    """序列化成持久化 JSON：字段名照请求自己的（视频 snake_case、图片 camelCase），归属字段单独存列。

    切图与上传没有请求，原样是 ``None``。"""

    if request is None:
        return None
    # JSON 模式：合成各段的出处是 UUID，要写成字符串才进得了 JSONB。
    return request.model_dump(mode="json", by_alias=True, exclude=set(ORIGIN_FIELDS))


def request_from_payload(
    kind: str, operation: str, payload: dict[str, Any] | None
) -> GenerationRequest | None:
    """按独立存列的 kind 与 operation 选择适配器并校验持久化请求，非法数据直接报错。

    切图与上传必须没有请求，读回 ``None``；其余几种必须有。校验带读回标记，视频请求里存下的
    ``prompt`` 原样保留，不按 ``shot`` 重拼。"""

    if (kind, operation) in _WITHOUT_REQUEST:
        if payload is not None:
            raise ValidationFailed(f"{kind} / {operation} 不该带请求")
        return None
    adapter = _ADAPTERS.get((kind, operation))
    if adapter is None:
        raise ValidationFailed(f"未知的生成类型: {kind} / {operation}")
    if payload is None:
        raise ValidationFailed(f"{kind} / {operation} 的生成请求缺失")
    try:
        return adapter.validate_python(payload, context={_READ_BACK: True})
    except ValueError as exc:
        raise ValidationFailed(f"生成请求的形状不合法: {exc}") from exc


class GenerationOut(CamelModel):
    """一次生成对外的样子。

    只给调用方用得上的：图在哪、跑到哪一步、失败了给人看什么。provider 名称、上游任务号
    与状态词、提交时刻都是排队与排障的内部机制；来源对话不写回去——查的时候本来就是按它查的。
    """

    id: uuid.UUID
    kind: GenerationKind
    operation: GenerationOperation
    status: GenerationStatus
    request: dict[str, Any] | None
    """发给执行方的输入，整份存取；切图与上传没有，为空。"""
    metadata: dict[str, Any] | None
    task_id: uuid.UUID | None
    shot_index: int | None = None
    """镜头组编号，只有视频有：出片由调用方给，编辑段与合成抄原作的；图片恒为空。"""
    root_job_id: uuid.UUID | None
    """原作：编辑段与合成指最初那条出片，出片、整片与图片为空。按它筛（``rootJobId``）拿到整条编辑链。"""
    source_job_id: uuid.UUID | None = None
    """直接来源：编辑段指待替换区间所属的基底成片，合成指基底成片，帧图编辑指底图，切图指宫格；
    别的为空，整片也没有。编辑段的实际参考记在 ``request.reference_video_urls``，合成与整片的
    各段出处记在 ``request.segments`` 里。"""
    source_url: str | None = None
    """来源的地址：``sourceJobId`` 非空时是那条记录的 ``outputUrl``；为空时只有帧图编辑可能有，是
    库里找不到的外部底图地址；都没有就是空。它是投影，不是列的镜像，来源那条读不读得到都照给。"""
    range_start_ms: int | None = None
    range_end_ms: int | None = None
    """编辑产物替换基底上的那一段，毫秒，就是受理时请求给的区间。只有编辑段有。"""
    output_url: str | None
    watermark_output_url: str | None
    """视频的水印版地址；图片与合成没有这一份，恒为空。"""
    error_message: str | None
    duration_ms: int | None
    """产物实际多长，毫秒，完成后才有：视频（出片与编辑段）取上游实测的时长，合成、整片与生成的
    背景音乐是本系统量的，图片与上传为空；上游没给也为空。"""
    clip_stage: ClipStage | None
    """在途的本地加工跑到哪一步：合成与整片的取素材、加工、上传。排队中、已有结论都为空；编辑段与
    别的记录没有本地加工，恒为空。"""
    sentences: list[SubtitleSentence] | None = None
    """字幕记录的结果：逐句的起止（毫秒）、文字与说话人，按识别服务给的先后。只有完成的字幕记录有，
    没有口播是空数组；别的记录与没完成的字幕记录为空。字幕记录没有 ``outputUrl``。"""
    created_at: datetime
    finished_at: datetime | None = None
    """到终态的时刻（数据库时钟）；同一镜头组的成片按它排版本。"""


def generation_out(job: GenerationJob, *, source_address: str | None) -> GenerationOut:
    """``source_address`` 是这一条来源的地址，由服务按来源批量查好给进来（见 ``GenerationOut.source_url``）。"""

    return GenerationOut(
        id=job.id,
        kind=job.kind,
        operation=job.operation,
        status=job.status,
        request=request_to_payload(job.request),
        metadata=job.metadata,
        task_id=job.task_id,
        shot_index=job.shot_index,
        root_job_id=job.root_job_id,
        source_job_id=job.source_job_id,
        source_url=source_address,
        range_start_ms=job.range_start_ms,
        range_end_ms=job.range_end_ms,
        output_url=job.output_url,
        watermark_output_url=job.watermark_output_url,
        error_message=job.error_message,
        duration_ms=job.duration_ms,
        clip_stage=_clip_stage(job),
        sentences=None if job.sentences is None else list(job.sentences),
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


def _clip_stage(job: GenerationJob) -> ClipStage | None:
    """在途的本地加工跑到哪一步。只有合成有本地加工，别的记录一律为空。

    只在 submitting 时认：收尾写终态时不带 provider_status，那一列会留着最后上报的阶段词，
    照它读会让一条已失败的记录看着还在上传。"""

    if job.operation != OPERATION_COMPOSE or job.status != STATUS_SUBMITTING:
        return None
    return next((stage for stage in CLIP_STAGES if stage == job.provider_status), None)


class VideoSubmitOut(SnakeModel):
    """视频提交的回执，照上游：只有任务号。这里的 ``task_id`` 是我们这条生成记录的 id。"""

    task_id: uuid.UUID


class VideoTaskResult(SnakeModel):
    output_url: str
    watermark_output_url: str


class VideoTaskError(SnakeModel):
    code: str
    message: str


VideoTaskStatus = Literal["queued", "running", "succeeded", "failed"]

_TASK_STATUS: Final[Mapping[GenerationStatus, VideoTaskStatus]] = {
    STATUS_PENDING: "queued",
    STATUS_SUBMITTING: "running",
    STATUS_SUBMITTED: "running",
    STATUS_COMPLETED: "succeeded",
    STATUS_FAILED: "failed",
}
"""我们的记录状态到上游状态词。调用方拿现成的上游轮询代码就能用。"""


class VideoTaskOut(SnakeModel):
    """视频任务快照，照上游任务查询的形状。"""

    task_id: uuid.UUID
    type: Literal["video"] = "video"
    status: VideoTaskStatus
    result: VideoTaskResult | None = None
    """``status == "succeeded"`` 时必有。"""
    error: VideoTaskError | None = None
    """``status == "failed"`` 时必有。"""
    created_at: datetime


def video_task_out(job: GenerationJob) -> VideoTaskOut:
    status = _TASK_STATUS[job.status]
    result = None
    error = None
    if status == "succeeded":
        if job.output_url is None or job.watermark_output_url is None:
            # 完成态两个地址都该有（provider 那边缺一个就判失败），到这儿为空是持久化状态坏了。
            raise RuntimeError(f"视频记录 {job.id} 已完成却缺结果地址")
        result = VideoTaskResult(
            output_url=job.output_url, watermark_output_url=job.watermark_output_url
        )
    if status == "failed":
        if job.error_code is None or job.error_message is None:
            raise RuntimeError(f"视频记录 {job.id} 已失败却没有错误信息")
        error = VideoTaskError(code=job.error_code, message=job.error_message)
    return VideoTaskOut(
        task_id=job.id, status=status, result=result, error=error, created_at=job.created_at
    )


class VideoModelsOut(CamelModel):
    """接入了哪几个视频模型。只有模型 id，下拉直接显示它。"""

    default: str
    items: list[str]


class ImageModelOut(CamelModel):
    """一家图片模型对外声明的能力。调用方照它决定能填什么，受理层照同一份声明拦。"""

    model: str
    label: str
    aspect_ratios: tuple[str, ...]
    resolutions: tuple[str, ...]
    channels: tuple[str, ...]
    """空数组表示这家没有渠道这个轴，别给它传 ``channel``。"""


class ImageModelsOut(CamelModel):
    default: str
    """请求省略 ``model`` 时用的那家。"""

    items: list[ImageModelOut]


class GenerationEnvelope(CamelModel):
    generation: GenerationOut


class GenerationsPageOut(CamelModel):
    items: list[GenerationOut]


__all__ = [
    "CLIP_FETCHING",
    "CLIP_PROCESSING",
    "CLIP_UPLOADING",
    "FILM_LOUDNESS_LUFS",
    "FILM_PEAK_DBFS",
    "IMAGE_MAX_REFERENCES",
    "KIND_AUDIO",
    "KIND_IMAGE",
    "KIND_SUBTITLE",
    "KIND_VIDEO",
    "MAX_COMPOSE_SEGMENTS",
    "MAX_METADATA_CHARS",
    "MAX_MODEL_CHARS",
    "MAX_MUSIC_GAIN_POINTS",
    "MAX_MUSIC_PROMPT_CHARS",
    "MAX_PROMPT_CHARS",
    "MAX_REFERENCE_URLS",
    "MAX_USER_NAME_CHARS",
    "MAX_WHOLE_FILM_MS",
    "MAX_WHOLE_FILM_SUBTITLES",
    "MAX_WHOLE_FILM_SUBTITLE_CHARS",
    "MUSIC_FADE_OUT_MS",
    "NOT_FORWARDED_FIELDS",
    "OPERATION_COMPOSE",
    "OPERATION_CUT",
    "OPERATION_GENERATE",
    "OPERATION_UPLOAD",
    "ORIGIN_FIELDS",
    "SEGMENT_FADE_MS",
    "SPEECH_LOUDNESS_LUFS",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_SUBMITTED",
    "STATUS_SUBMITTING",
    "ClipStage",
    "ComposeRequest",
    "ComposeSegment",
    "ComposeSegmentIn",
    "GenerationEnvelope",
    "GenerationKind",
    "GenerationOperation",
    "GenerationOut",
    "GenerationRequest",
    "GenerationStatus",
    "GenerationsPageOut",
    "ImageGenerationIn",
    "ImageModelOut",
    "ImageModelsOut",
    "Metadata",
    "MusicGainPoint",
    "MusicIn",
    "MusicRequest",
    "SubtitleIn",
    "SubtitleRequest",
    "SubtitleSentence",
    "VideoComposeIn",
    "VideoComposeRequest",
    "VideoEditIn",
    "VideoGenerationIn",
    "VideoModelsOut",
    "VideoShotIn",
    "VideoShotTimelineItemIn",
    "VideoSubmitOut",
    "VideoTaskError",
    "VideoTaskOut",
    "VideoTaskResult",
    "VideoTaskStatus",
    "WholeFilmBrand",
    "WholeFilmBrandIn",
    "WholeFilmFont",
    "WholeFilmIn",
    "WholeFilmMusic",
    "WholeFilmMusicIn",
    "WholeFilmRender",
    "WholeFilmRequest",
    "WholeFilmSegment",
    "WholeFilmSegmentIn",
    "WholeFilmSubtitle",
    "generation_out",
    "request_from_payload",
    "request_to_payload",
    "sentences_from_payload",
    "sentences_to_payload",
    "video_task_out",
]
