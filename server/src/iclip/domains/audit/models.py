"""审计查询的入口形状：筛选范围、粒度与任务执行清单的排序词表。报表的读模型见 schemas.py。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

OverviewBucket = Literal["hour", "day", "week"]
"""趋势的粒度，由服务端按时间窗跨了几个日历日选定；时段查询也只切这几种。"""

ExecutionSort = Literal["start", "retries", "cycle", "tokens"]
"""任务执行清单的排序键：开始（对话建立时刻）、每镜头重试次数、运行时长、token 消耗。"""

SortOrder = Literal["asc", "desc"]

ExecutionAnomalyKind = Literal["retry", "stuck", "spend", "task_stuck"]
"""任务执行上标的四种异常：反复重试、视频悬挂、消耗离群、需求单卡住。"""


@dataclass(frozen=True, slots=True)
class Scope:
    """一次查询的筛选范围。时间窗 ``[since, until)`` 作用在各指标自己的锚点上，见各查询。"""

    since: datetime | None = None
    until: datetime | None = None
    user_name: str | None = None


__all__ = [
    "ExecutionAnomalyKind",
    "ExecutionSort",
    "OverviewBucket",
    "Scope",
    "SortOrder",
]
