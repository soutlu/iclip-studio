"""参考视频的领域形状：两份标签清单、拆解状态与失败原因、一行记录。术语见 docs/CONTEXT.md「参考视频」。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal, get_args

VideoTypeValue = Literal[
    "live_clip",
    "slideshow",
    "drama",
    "review",
    "talking_head",
    "try_on",
    "lifestyle",
    "product_showcase",
]
"""片子类型标签的取值；说明与显示名在 ``VIDEO_TYPES``。"""


@dataclass(frozen=True, slots=True)
class VideoType:
    value: VideoTypeValue
    label: str
    rule: str
    """怎么判断：界面说明和打标提示词都读这一句。"""


VIDEO_TYPES: Final[tuple[VideoType, ...]] = (
    VideoType("live_clip", "直播切片", "画面来自直播间，主播在直播布景前讲"),
    VideoType("slideshow", "图文混剪", "不是连贯的实拍：由图片、零散素材拼成，或是动画、三维渲染"),
    VideoType("drama", "剧情", "有角色和情节，人物之间的互动推着故事往前走"),
    VideoType("review", "开箱测评", "拆包装上手，或在片中做测试、对比"),
    VideoType("talking_head", "口播", "有人对着镜头讲，说话占了大部分时长"),
    VideoType("try_on", "上身展示", "模特穿上或戴上产品，展示上身效果"),
    VideoType("lifestyle", "场景种草", "人物在生活场景里自然地使用产品，不对着镜头讲解"),
    VideoType(
        "product_showcase", "产品展示", "产品本身是主体，拍特写、细节、功能，或拍它怎么做出来"
    ),
)
"""片子类型的全部取值。一条视频可以有几个类型；这里的顺序只是显示顺序。"""

if tuple(one.value for one in VIDEO_TYPES) != get_args(VideoTypeValue):
    raise RuntimeError("VIDEO_TYPES 与 VideoTypeValue 的取值或顺序对不上")

CategoryValue = Literal[
    # 照抄 PDM 品类表的全部第四级，以后由我们维护，不再读 PDM。
    "高跟鞋",
    "平底鞋",
    "乐福鞋",
    "牛津鞋",
    "一脚蹬",
    "穆勒鞋",
    "拖鞋",
    "短靴",
    "中筒靴",
    "及膝靴",
    "过膝靴",
    "高跟凉鞋",
    "坡跟凉鞋",
    "厚底凉鞋",
    "平底凉鞋",
    "夹趾拖",
    "凉拖鞋",
    "运动凉鞋",
    "跑鞋",
    "足球鞋",
    "篮球鞋",
    "啦啦队鞋",
    "棒&垒球鞋",
    "滑板鞋",
    "舞蹈鞋",
    "橄榄球鞋",
    "高尔夫鞋",
    "网球鞋",
    "训练鞋",
    "女性骑行鞋",
    "健步鞋",
    "板鞋",
    "徒步鞋",
    "徒步靴",
    "雪地靴",
    "雨靴",
    "水鞋",
    "猎靴",
    "医疗用鞋",
    "餐厨用鞋",
    "军事用靴",
    "工业用鞋",
    "工业用靴",
    "皮带",
    "钱包",
    "包",
    "袜子",
    "鞋垫",
    # PDM 没有服装，自己加。
    "T恤",
    "衬衫",
    "卫衣",
    "毛衣",
    "外套",
    "裤子",
    "半身裙",
    "连衣裙",
]

CATEGORIES: Final[tuple[CategoryValue, ...]] = get_args(CategoryValue)
"""品类标签的全部取值，存的就是名字。界面筛选、详情多选和打标提示词都读这一份；改名或增删要连带
处理已经打上的标签。"""

BreakdownStatus = Literal["pending", "running", "completed", "failed"]
"""``pending`` 已排队；``running`` 后台在拆解与打标；``completed`` 有拆解；``failed`` 最近一次没拆成，
原来的拆解与标签保留。"""

STATUS_PENDING: Final = "pending"
STATUS_RUNNING: Final = "running"
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

BreakdownErrorCode = Literal["video_unreadable", "model_call_failed", "model_failed", "timeout"]
"""最近一次拆解失败的原因。``video_unreadable`` 取不到或解不开视频；``model_call_failed`` 模型调用
失败（限流、服务端错、连不上、答得不完整），再试可能就好；``model_failed`` 请求被拒或等满了总超时；
``timeout`` 拆解中超过 ``BREAKDOWN_TIMEOUT_SECONDS`` 没结束，被周期任务收尾。"""

ERROR_VIDEO_UNREADABLE: Final = "video_unreadable"
ERROR_MODEL_CALL_FAILED: Final = "model_call_failed"
ERROR_MODEL_FAILED: Final = "model_failed"
ERROR_TIMEOUT: Final = "timeout"

BREAKDOWN_TIMEOUT_SECONDS: Final = 20 * 60
"""拆解中的行最多等这么久：单次拆解请求最长 900 秒，再加打标与余量。超过即按 ``timeout`` 收尾；导演
等一条拆解的上限也是它。"""


class BreakdownFailed(Exception):
    """一次拆解没有产出文档；``code`` 是落到行上的失败原因。"""

    def __init__(self, message: str, *, code: BreakdownErrorCode) -> None:
        super().__init__(message)
        self.code: BreakdownErrorCode = code


class TaggingFailed(Exception):
    """打标没有给出可用的标签：调用失败、不是合法 JSON，或给了清单外的值。"""


@dataclass(frozen=True, slots=True)
class Tags:
    """一条视频的两组标签，已去重；空就是未标注。"""

    video_types: tuple[VideoTypeValue, ...] = ()
    categories: tuple[CategoryValue, ...] = ()


@dataclass(frozen=True, slots=True)
class ReferenceVideo:
    """``reference_videos`` 的一行，连同属主的用户名。"""

    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
    owner_user_name: str | None
    video_types: tuple[VideoTypeValue, ...]
    categories: tuple[CategoryValue, ...]
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    document: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


@dataclass(frozen=True, slots=True)
class Claim:
    """后台任务接手的一次拆解。``started_at`` 是这一次的凭据：写回时核对它，被收尾后又重拆的行不会
    被上一次的结果盖掉。"""

    id: uuid.UUID
    video_url: str
    started_at: datetime


@dataclass(frozen=True, slots=True)
class Outcome:
    """导演等一条拆解的结果：有文档就用文档，否则是失败原因。"""

    document: str | None
    error_code: BreakdownErrorCode | None = None


TestVideoStatus = Literal["running", "completed", "failed"]
"""试生成的状态：``running`` 还没结束（排队、提交中或等上游），其余是终态。"""

TEST_VIDEO_RUNNING: Final = "running"
TEST_VIDEO_COMPLETED: Final = "completed"
TEST_VIDEO_FAILED: Final = "failed"


@dataclass(frozen=True, slots=True)
class TestVideoJob:
    """属主名下这条参考视频最新的一次试生成，从生成记录投影过来，不引用生成域的类型。"""

    status: TestVideoStatus
    url: str | None
    """成片地址；还没完成或失败了为 ``None``。"""
    error_message: str | None
    """上游给的失败原文。"""
    prompt: str | None
    """记录里发给模型的正文；记录读不出视频请求时为 ``None``。"""
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Scope:
    """列表的筛选范围。两组标签各自命中任一即算；时间窗 ``[since, until)`` 作用在建立时刻上。"""

    video_types: tuple[VideoTypeValue, ...] = ()
    categories: tuple[CategoryValue, ...] = ()
    user_name: str | None = None
    """属主的用户名。"""
    q: str | None = None
    """按字面包含匹配拆解全文，不区分大小写。"""
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class ReferenceCursor:
    """列表的排序键：建立时刻加行 id。"""

    at: datetime
    reference_id: uuid.UUID


__all__ = [
    "BREAKDOWN_TIMEOUT_SECONDS",
    "CATEGORIES",
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "ERROR_TIMEOUT",
    "ERROR_VIDEO_UNREADABLE",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TEST_VIDEO_COMPLETED",
    "TEST_VIDEO_FAILED",
    "TEST_VIDEO_RUNNING",
    "VIDEO_TYPES",
    "BreakdownErrorCode",
    "BreakdownFailed",
    "BreakdownStatus",
    "CategoryValue",
    "Claim",
    "Outcome",
    "ReferenceCursor",
    "ReferenceVideo",
    "Scope",
    "TaggingFailed",
    "Tags",
    "TestVideoJob",
    "TestVideoStatus",
    "VideoType",
    "VideoTypeValue",
]
