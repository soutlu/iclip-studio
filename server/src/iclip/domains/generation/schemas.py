from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, ClassVar, Final, Literal, get_args, overload

from agent_runtime.urls import is_http_url
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from iclip.common.generation_vocab import (
    GenerationKind,
    GenerationOperation,
    GenerationStatus,
    VideoEnhanceResolution,
)
from iclip.common.shot_prompt import format_seconds, format_shot_prompt
from iclip.common.shot_rules import (
    MAX_REFERENCE_IMAGES,
    first_unavailable_image,
    image_indexes_of,
    timeline_fault,
)

if TYPE_CHECKING:
    from iclip.domains.generation.models import GenerationJob
    from iclip.domains.generation.stored_requests import GenerationRequest

STATUS_PENDING: Final = "pending"
STATUS_SUBMITTING: Final = "submitting"
STATUS_SUBMITTED: Final = "submitted"
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

KIND_VIDEO: Final = "video"
KIND_IMAGE: Final = "image"
KIND_SUBTITLE: Final = "subtitle"
KIND_AUDIO: Final = "audio"
KIND_WHOLE_FILM: Final = "whole_film"

OPERATION_GENERATE: Final = "generate"
OPERATION_COMPOSE: Final = "compose"
OPERATION_CUT: Final = "cut"
OPERATION_UPLOAD: Final = "upload"
OPERATION_RENDER: Final = "render"
OPERATION_ENHANCE: Final = "enhance"

ClipStage = Literal["fetching", "processing", "uploading"]

CLIP_FETCHING: Final = "fetching"
CLIP_PROCESSING: Final = "processing"
CLIP_UPLOADING: Final = "uploading"

CLIP_STAGES: Final[tuple[ClipStage, ...]] = get_args(ClipStage)

IMAGE_ASPECT_RATIOS = Literal[
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
]
IMAGE_RESOLUTIONS = Literal["1k", "2k", "4k"]

IMAGE_MAX_REFERENCES: Final = 10
MAX_PROMPT_CHARS: Final = 4000
MAX_REFERENCE_URLS: Final = MAX_REFERENCE_IMAGES
MAX_MODEL_CHARS: Final = 200
MAX_USER_NAME_CHARS: Final = 200
MAX_METADATA_CHARS: Final = 2000
MAX_URL_CHARS: Final = 2000
MAX_COMPOSE_SEGMENTS: Final = 100

COLUMN_FIELDS: Final = frozenset({"conversation_id", "task_id", "metadata", "shot_index"})
"""请求里落成记录列的字段：不进请求快照。"""

RECORD_ONLY_FIELDS: Final = frozenset({"source_url", "range_start_ms", "range_end_ms"})
"""进请求快照、但只记账的字段：不转发给上游，对外的 ``request`` 里不给，另有顶层字段。"""

NOT_FORWARDED_FIELDS: Final = COLUMN_FIELDS | RECORD_ONLY_FIELDS | frozenset({"shot"})

READ_BACK_CONTEXT: Final = "read_back"


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SnakeModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


Prompt = Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)]
ModelName = Annotated[str, Field(min_length=1, max_length=MAX_MODEL_CHARS)]
UserName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS)
]

MediaUrls = Annotated[list[str], Field(max_length=MAX_REFERENCE_URLS)]


def _http_only(urls: list[str]) -> list[str]:
    for index, url in enumerate(urls):
        if not is_http_url(url):
            raise ValueError(f"[{index}] 必须是 http:// 或 https:// 地址")
    return urls


def _http_url(url: str) -> str:
    if not is_http_url(url):
        raise ValueError("必须是 http:// 或 https:// 地址")
    return url


DownloadUrl = Annotated[
    str, Field(min_length=1, max_length=MAX_URL_CHARS), AfterValidator(_http_url)
]


def _bounded_metadata(value: dict[str, Any]) -> dict[str, Any]:
    if len(json.dumps(value, ensure_ascii=False, default=str)) > MAX_METADATA_CHARS:
        raise ValueError(f"metadata 序列化后不能超过 {MAX_METADATA_CHARS} 字符")
    return value


Metadata = Annotated[dict[str, Any], AfterValidator(_bounded_metadata)]


def nonblank(text: str) -> str:
    if not text.strip():
        raise ValueError("不能是空白")
    return text


Seconds = Annotated[float, Field(ge=0)]


class VideoShotTimelineItemIn(SnakeModel):
    """镜头组里的一镜：起止时间、说什么、引了哪几张图。与分镜文件 video_shot.json 里的一镜同形。"""

    timestamps: tuple[Seconds, Seconds]
    prompt: Annotated[str, Field(max_length=MAX_PROMPT_CHARS)]
    image_indexes: list[Annotated[int, Field(ge=1)]]

    _check_prompt = field_validator("prompt")(nonblank)

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

    _check_global_settings = field_validator("global_settings")(nonblank)

    @model_validator(mode="after")
    def _timeline_runs_forward(self) -> VideoShotIn:
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


class VideoGenerationIn(SnakeModel):
    """一次视频生成的输入。字段照上游异步接口，外加归属字段、坐标 ``metadata`` 与结构化的 ``shot``。

    只拦本系统能判的：模型在允许表里（受理层）、地址是 http(s)、秒数不小于 -1、``shot``
    自身对得上（图片引用不越界、编号与正文一致）。画幅、分辨率、时长范围、素材规格由上游
    按模型判，这里不复制一份。
    """

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    model: ModelName
    prompt: Prompt | None = None
    shot: VideoShotIn | None = None
    user_name: UserName | None = None
    reference_image_urls: MediaUrls = []
    reference_video_urls: MediaUrls = []
    reference_audio_urls: MediaUrls = []
    generate_audio: bool | None = None
    resolution: Annotated[str, Field(min_length=1, max_length=50)] | None = None
    aspect_ratio: Annotated[str, Field(min_length=1, max_length=20)] | None = None
    seconds: Annotated[int, Field(ge=-1)] | None = None
    provider_options: dict[str, Any] | None = None

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None
    shot_index: Annotated[int, Field(ge=1)] | None = None

    _check_urls = field_validator(
        "reference_image_urls", "reference_video_urls", "reference_audio_urls"
    )(_http_only)

    @model_validator(mode="after")
    def _assemble_prompt_from_shot(self, info: ValidationInfo) -> VideoGenerationIn:
        if self.shot is None:
            if self.prompt is None:
                raise ValueError("prompt 与 shot 至少传一个")
            return self
        _check_image_references(self.shot, len(self.reference_image_urls))
        if isinstance(info.context, dict) and info.context.get(READ_BACK_CONTEXT) is True:
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


class VideoEditRequest(VideoGenerationIn):
    """编辑段的请求快照：转发给上游的那条视频请求，外加只记账的替换区间（基底媒体时间，毫秒）。"""

    range_start_ms: Annotated[int, Field(ge=0)]
    range_end_ms: int


class ImageGenerationIn(CamelModel):
    """一次图像生成的输入。参考图为空即文生图，否则走图像编辑。"""

    kind: ClassVar[GenerationKind] = KIND_IMAGE
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    prompt: Prompt
    user_name: UserName | None = None
    model: ModelName | None = None
    channel: Literal["dev", "pro"] | None = None
    aspect_ratio: IMAGE_ASPECT_RATIOS
    resolution: IMAGE_RESOLUTIONS = "1k"
    reference_image_urls: Annotated[list[str], Field(max_length=IMAGE_MAX_REFERENCES)] = []

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None
    source_url: DownloadUrl | None = None

    _check_urls = field_validator("reference_image_urls")(_http_only)


class VideoEditIn(SnakeModel):
    """一次编辑段的受理输入：一次上游视频请求，外加只记账的替换基底与区间。

    转发给上游的字段照上游命名。有参考视频时编辑调用方按当前选用素材裁剪、拼接后上传的
    片段；没有参考视频时按正文引用的图片生成替换片段。产物时长不必等于基底替换区间。
    ``source_job_id`` 与 ``range_start_ms`` / ``range_end_ms`` 只记账、不参与处理，有了它们这条
    记录才是编辑段。不收 ``shot`` 与原作：编辑段只有正文，原作由基底定。受理后落库的是一条
    ``VideoEditRequest``：来源与原作落列，区间记在请求快照里。"""

    source_job_id: uuid.UUID
    range_start_ms: Annotated[int, Field(ge=0)]
    range_end_ms: int
    reference_video_urls: Annotated[list[str], Field(max_length=1)] = []
    model: ModelName
    prompt: Prompt
    user_name: UserName | None = None
    reference_image_urls: MediaUrls = []
    seconds: Annotated[int, Field(ge=-1, strict=True)]
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
    start: float = Field(ge=0)
    end: float | None = None

    @model_validator(mode="after")
    def _end_after_start(self) -> ComposeSegmentIn:
        if self.end is not None and self.end <= self.start:
            raise ValueError("end 必须大于 start")
        return self


class VideoComposeIn(CamelModel):
    """一次合成的受理输入：基底那一版加一串有序片段，服务端核对各段出处后换成地址再拼。"""

    base_job_id: uuid.UUID
    segments: Annotated[
        list[ComposeSegmentIn], Field(min_length=1, max_length=MAX_COMPOSE_SEGMENTS)
    ]
    user_name: UserName | None = None

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None


class ComposeSegment(ComposeSegmentIn):
    url: DownloadUrl


class VideoComposeRequest(CamelModel):
    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_COMPOSE

    segments: Annotated[list[ComposeSegment], Field(min_length=1)]
    user_name: UserName | None = None


class SubtitleIn(CamelModel):
    """手动识别一条素材片的受理输入：补识别旧视频，或识别失败后另起一次。

    归属参数与别的提交端点一样；``userName`` 只用来替人办事（持 ``users:act_as`` 的钥匙），识别
    服务不收它，不进 ``request``。"""

    source_job_id: uuid.UUID
    user_name: UserName | None = None

    conversation_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None


class SubtitleRequest(CamelModel):
    kind: ClassVar[GenerationKind] = KIND_SUBTITLE
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    model: ModelName
    video_url: DownloadUrl
    audio_format: Literal["mp3"] = "mp3"
    sample_rate: Literal[16000] = 16000
    speaker_diarization: Literal[True] = True


class SubtitleWord(CamelModel):
    """一句里的一个词：在视频里的起止（毫秒）、文字与紧跟其后的标点（没有就是空串）。"""

    start_ms: Annotated[int, Field(ge=0)]
    end_ms: Annotated[int, Field(ge=0)]
    text: str
    punctuation: str = ""

    @model_validator(mode="after")
    def _end_not_before_start(self) -> SubtitleWord:
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms 不能早于 start_ms")
        return self


class SubtitleSentence(CamelModel):
    """字幕里的一句：在视频里的起止（毫秒）、文字、说话人与逐词时间。落库是 snake_case 的键，对外
    camelCase；早先的记录没有逐词时间，读出来是空。"""

    start_ms: Annotated[int, Field(ge=0)]
    end_ms: Annotated[int, Field(ge=0)]
    text: str
    speaker: int | None
    words: tuple[SubtitleWord, ...] = ()

    @model_validator(mode="after")
    def _end_not_before_start(self) -> SubtitleSentence:
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms 不能早于 start_ms")
        return self


MAX_MUSIC_PROMPT_CHARS: Final = 3000

MusicPrompt = Annotated[str, Field(min_length=1, max_length=MAX_MUSIC_PROMPT_CHARS)]


class MusicIn(CamelModel):
    """生成一段背景音乐的受理输入。

    ``prompt`` 原样发给音乐模型，服务端不补任何文字；音乐多长由模型决定。归属参数与别的提交端点
    一样，只是对话必填：背景音乐属于一段对话。``userName`` 只用来替人办事，音乐模型不收
    它，不进 ``request``。"""

    prompt: MusicPrompt
    user_name: UserName | None = None

    conversation_id: uuid.UUID
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None

    _check_prompt = field_validator("prompt")(nonblank)


class MusicRequest(CamelModel):
    kind: ClassVar[GenerationKind] = KIND_AUDIO
    operation: ClassVar[GenerationOperation] = OPERATION_GENERATE

    model: ModelName
    prompt: MusicPrompt
    format: Literal["wav"] = "wav"
    sample_rate: Literal[48000] = 48000
    channels: Literal[2] = 2


class WholeFilmVideoSource(CamelModel):
    """导出用到的一条素材片：记录 id 与它的公开地址。"""

    job_id: uuid.UUID
    url: DownloadUrl


class WholeFilmMusicSource(CamelModel):
    job_id: uuid.UUID
    url: DownloadUrl


class WholeFilmSubtitles(CamelModel):
    """一条素材片最新的那条已完成字幕记录的逐句结果。"""

    source_job_id: uuid.UUID
    subtitle_job_id: uuid.UUID
    sentences: tuple[SubtitleSentence, ...]


class WholeFilmRequest(CamelModel):
    """一次成片导出交给渲染服务的全部输入，受理时定下，之后不变。生成域不解析草稿。

    ``videos`` 是画面轨用到的素材片，去重、按第一次出现的先后；用列表是因为 JSONB 不保留键序。"""

    kind: ClassVar[GenerationKind] = KIND_WHOLE_FILM
    operation: ClassVar[GenerationOperation] = OPERATION_RENDER

    revision: int
    """导出的那一版草稿。"""
    document: dict[str, Any]
    """草稿原样（camelCase 的 JSON）。"""
    videos: list[WholeFilmVideoSource]
    music: WholeFilmMusicSource | None
    subtitles: list[WholeFilmSubtitles]


class VideoEnhanceIn(CamelModel):
    """给一条素材片或一条导出的成片做高清版的受理输入。

    ``userName`` 的规则同出片：发给上游对账，持 ``users:act_as`` 的钥匙按它替人办事。"""

    source_job_id: uuid.UUID
    resolution: VideoEnhanceResolution
    user_name: UserName | None = None


class VideoEnhanceRequest(SnakeModel):
    """一次超分交给上游的全部输入，字段照上游超分接口，原样转发。"""

    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_ENHANCE

    model: ModelName
    resolution: VideoEnhanceResolution
    fps: Annotated[int, Field(ge=15, le=60)] | None = None
    """目标帧率；为空就不插帧，不发给上游。"""
    video_url: DownloadUrl
    """来源的原片地址，不是水印版。"""
    user_name: UserName


@overload
def request_to_payload(request: GenerationRequest) -> dict[str, Any]: ...
@overload
def request_to_payload(request: None) -> None: ...
def request_to_payload(request: GenerationRequest | None) -> dict[str, Any] | None:
    """请求快照落库的形状：落成列的字段不存，外部底图只在有的时候存。"""

    if request is None:
        return None
    exclude = set(COLUMN_FIELDS)
    if isinstance(request, ImageGenerationIn) and request.source_url is None:
        exclude.add("source_url")
    return request.model_dump(mode="json", by_alias=True, exclude=exclude)


def _request_out(request: GenerationRequest | None) -> dict[str, Any] | None:
    if request is None:
        return None
    return request.model_dump(
        mode="json", by_alias=True, exclude=set(COLUMN_FIELDS | RECORD_ONLY_FIELDS)
    )


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
    metadata: dict[str, Any] | None
    task_id: uuid.UUID | None
    shot_index: int | None = None
    root_job_id: uuid.UUID | None
    source_job_id: uuid.UUID | None = None
    source_url: str | None = None
    range_start_ms: int | None = None
    range_end_ms: int | None = None
    output_url: str | None
    watermark_output_url: str | None
    error_message: str | None
    duration_ms: int | None
    clip_stage: ClipStage | None
    sentences: list[SubtitleSentence] | None = None
    created_at: datetime
    finished_at: datetime | None = None


def generation_out(job: GenerationJob, *, source_address: str | None) -> GenerationOut:
    edit = job.request if isinstance(job.request, VideoEditRequest) else None
    return GenerationOut(
        id=job.id,
        kind=job.kind,
        operation=job.operation,
        status=job.status,
        request=_request_out(job.request),
        metadata=job.metadata,
        task_id=job.task_id,
        shot_index=job.shot_index,
        root_job_id=job.root_job_id,
        source_job_id=job.source_job_id,
        source_url=source_address,
        range_start_ms=None if edit is None else edit.range_start_ms,
        range_end_ms=None if edit is None else edit.range_end_ms,
        output_url=job.output.url,
        watermark_output_url=job.output.watermark_url,
        error_message=job.error_message,
        duration_ms=job.output.duration_ms,
        clip_stage=_clip_stage(job),
        sentences=None if job.output.sentences is None else list(job.output.sentences),
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


def _clip_stage(job: GenerationJob) -> ClipStage | None:
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


class VideoTaskOut(SnakeModel):
    """视频任务快照，照上游任务查询的形状。"""

    task_id: uuid.UUID
    type: Literal["video"] = "video"
    status: VideoTaskStatus
    result: VideoTaskResult | None = None
    error: VideoTaskError | None = None
    created_at: datetime


def video_task_out(job: GenerationJob) -> VideoTaskOut:
    status = _TASK_STATUS[job.status]
    result = None
    error = None
    if status == "succeeded":
        if job.output.url is None or job.output.watermark_url is None:
            raise RuntimeError(f"视频记录 {job.id} 已完成却缺结果地址")
        result = VideoTaskResult(
            output_url=job.output.url, watermark_output_url=job.output.watermark_url
        )
    if status == "failed":
        if job.error_code is None or job.error_message is None:
            raise RuntimeError(f"视频记录 {job.id} 已失败却没有错误信息")
        error = VideoTaskError(code=job.error_code, message=job.error_message)
    return VideoTaskOut(
        task_id=job.id, status=status, result=result, error=error, created_at=job.created_at
    )


class ClipEditDurationOut(CamelModel):
    """片段编辑接受的实际参考视频时长范围，单位秒。"""

    min_seconds: int
    max_seconds: int


class ClipImageDurationOut(CamelModel):
    """图生片段的输出时长范围，按整秒选择。"""

    min_seconds: int
    max_seconds: int
    default_seconds: int


class VideoClipModelOut(CamelModel):
    """视频编辑页可以使用的模型；edit 为空表示只支持图生。"""

    id: str
    max_reference_images: int
    image: ClipImageDurationOut
    edit: ClipEditDurationOut | None


class VideoModelsOut(CamelModel):
    """配置允许的视频模型，以及片段入口已接入的模型能力。"""

    default: str
    items: list[str]
    clip_models: list[VideoClipModelOut]


class ImageModelOut(CamelModel):
    """一家图片模型对外声明的能力。调用方照它决定能填什么，受理层照同一份声明拦。"""

    model: str
    label: str
    aspect_ratios: tuple[str, ...]
    resolutions: tuple[str, ...]
    channels: tuple[str, ...]


class ImageModelsOut(CamelModel):
    default: str

    items: list[ImageModelOut]


class GenerationEnvelope(CamelModel):
    generation: GenerationOut


class VideoEnhanceTierOut(CamelModel):
    """高清版的一档：清晰度与这一档最近的一条超分记录（谁提的都算），还没有为空。"""

    resolution: VideoEnhanceResolution
    job: GenerationOut | None
    mine: bool
    """``job`` 的属主是不是这次读的主体；没有记录为 false。"""


class VideoEnhancementsOut(CamelModel):
    """一条视频能做的高清版各档，以及下载高清版时记下载事件的素材片。"""

    downloaded_job_ids: list[uuid.UUID]
    """视频是它自己；成片是它导出时用到的各条素材片。来源做不了高清版时为空。"""
    tiers: list[VideoEnhanceTierOut]
    """比来源清晰的那几档，按运行配置的先后；没开通或来源做不了高清版时为空。"""


class GenerationsPageOut(CamelModel):
    items: list[GenerationOut]


__all__ = [
    "CLIP_FETCHING",
    "CLIP_PROCESSING",
    "CLIP_UPLOADING",
    "COLUMN_FIELDS",
    "IMAGE_MAX_REFERENCES",
    "KIND_AUDIO",
    "KIND_IMAGE",
    "KIND_SUBTITLE",
    "KIND_VIDEO",
    "KIND_WHOLE_FILM",
    "MAX_COMPOSE_SEGMENTS",
    "MAX_METADATA_CHARS",
    "MAX_MODEL_CHARS",
    "MAX_MUSIC_PROMPT_CHARS",
    "MAX_PROMPT_CHARS",
    "MAX_REFERENCE_URLS",
    "MAX_URL_CHARS",
    "MAX_USER_NAME_CHARS",
    "NOT_FORWARDED_FIELDS",
    "OPERATION_COMPOSE",
    "OPERATION_CUT",
    "OPERATION_ENHANCE",
    "OPERATION_GENERATE",
    "OPERATION_RENDER",
    "OPERATION_UPLOAD",
    "READ_BACK_CONTEXT",
    "RECORD_ONLY_FIELDS",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_SUBMITTED",
    "STATUS_SUBMITTING",
    "CamelModel",
    "ClipEditDurationOut",
    "ClipImageDurationOut",
    "ClipStage",
    "ComposeSegment",
    "ComposeSegmentIn",
    "DownloadUrl",
    "GenerationEnvelope",
    "GenerationKind",
    "GenerationOperation",
    "GenerationOut",
    "GenerationStatus",
    "GenerationsPageOut",
    "ImageGenerationIn",
    "ImageModelOut",
    "ImageModelsOut",
    "Metadata",
    "MusicIn",
    "MusicRequest",
    "SnakeModel",
    "SubtitleIn",
    "SubtitleRequest",
    "SubtitleSentence",
    "SubtitleWord",
    "UserName",
    "VideoClipModelOut",
    "VideoComposeIn",
    "VideoComposeRequest",
    "VideoEditIn",
    "VideoEditRequest",
    "VideoEnhanceIn",
    "VideoEnhanceRequest",
    "VideoEnhanceResolution",
    "VideoEnhanceTierOut",
    "VideoEnhancementsOut",
    "VideoGenerationIn",
    "VideoModelsOut",
    "VideoShotIn",
    "VideoShotTimelineItemIn",
    "VideoSubmitOut",
    "VideoTaskError",
    "VideoTaskOut",
    "VideoTaskResult",
    "VideoTaskStatus",
    "WholeFilmMusicSource",
    "WholeFilmRequest",
    "WholeFilmSubtitles",
    "WholeFilmVideoSource",
    "generation_out",
    "nonblank",
    "request_to_payload",
    "video_task_out",
]
