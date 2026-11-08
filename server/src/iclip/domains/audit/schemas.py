from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final

from pydantic import BaseModel, ConfigDict, computed_field
from pydantic.alias_generators import to_camel

from iclip.domains.audit.models import ExecutionAnomalyKind, OverviewBucket


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class SpreadOut(CamelModel):
    """一组时长样本的分布，单位秒。"""

    avg: float
    median: float
    p90: float
    count: int


class UsageOut(CamelModel):
    requests: int
    input_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    output_tokens: int

    @computed_field
    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
            + self.output_tokens
        )

    @computed_field
    @property
    def cache_hit_rate(self) -> float | None:
        """缓存读取 ÷（新输入 + 缓存读取 + 缓存写入）；没有输入时为空。"""

        read_in = self.input_tokens + self.cache_read_tokens + self.cache_write_tokens
        return self.cache_read_tokens / read_in if read_in else None


NO_USAGE: Final = UsageOut(
    requests=0, input_tokens=0, cache_read_tokens=0, cache_write_tokens=0, output_tokens=0
)


class MetricsOut(CamelModel):
    """一格指标。全体、人、时段、对话各层都是这个形状，只是维度键不同；见合同 §12。"""

    completed_videos: int
    delivered_tasks: int
    delivered_orphan_conversations: int
    producers: int
    shots: int
    attempts: int
    one_take_shots: int
    effective_shots: int
    runs: int
    active_users: int
    delivered_conversations: int
    cycle_seconds: SpreadOut | None
    active_cycle_seconds: SpreadOut | None
    agent_run_seconds: SpreadOut | None
    upstream_seconds: SpreadOut | None
    length_videos: int
    length_seconds: float
    discarded_length_seconds: float
    usage: UsageOut

    @computed_field
    @property
    def deliveries(self) -> int:
        """出片件数：有出片的需求单各一件，加没挂需求单却有出片的对话各一件。"""

        return self.delivered_tasks + self.delivered_orphan_conversations

    @computed_field
    @property
    def attempts_per_shot(self) -> float | None:
        return self.attempts / self.shots if self.shots else None

    @computed_field
    @property
    def one_take_rate(self) -> float | None:
        """一次通过率：只用一次成功生成就达标的镜占镜数的比例。"""

        return self.one_take_shots / self.shots if self.shots else None

    @computed_field
    @property
    def effective_rate(self) -> float | None:
        """有效率：有效镜占镜数的比例。"""

        return self.effective_shots / self.shots if self.shots else None

    @computed_field
    @property
    def tokens_per_delivery(self) -> float | None:
        return self.usage.total_tokens / self.deliveries if self.deliveries else None


EMPTY_METRICS: Final = MetricsOut(
    completed_videos=0,
    delivered_tasks=0,
    delivered_orphan_conversations=0,
    producers=0,
    shots=0,
    attempts=0,
    one_take_shots=0,
    effective_shots=0,
    runs=0,
    active_users=0,
    delivered_conversations=0,
    cycle_seconds=None,
    active_cycle_seconds=None,
    agent_run_seconds=None,
    upstream_seconds=None,
    length_videos=0,
    length_seconds=0.0,
    discarded_length_seconds=0.0,
    usage=NO_USAGE,
)


class AttemptBucketOut(CamelModel):
    """成功生成正好 ``attempts`` 次的镜有多少个。"""

    attempts: int
    shots: int


class PeriodMetricsOut(CamelModel):
    period_start: datetime
    metrics: MetricsOut


class OverviewWindowOut(CamelModel):
    """本期与上一期的起止。上一期是两端各往前挪本期跨的日历日数，粒度由跨度定；见合同 §12。"""

    since: datetime
    until: datetime
    previous_since: datetime
    previous_until: datetime
    bucket: OverviewBucket
    timezone: str
    generated_at: datetime


class OverviewPeriodOut(CamelModel):
    """一期的整段指标，分位数按整段现算，不由各期拼。"""

    metrics: MetricsOut
    active_days: int


class MovingAverageOut(CamelModel):
    """一条均线在某一期的值与它实际覆盖的时间窗；窗往前补过时 ``since`` 比名义起点早。"""

    value: float | None
    since: datetime
    until: datetime


class MovingAveragesOut(CamelModel):
    """一期末尾往前推 7 或 30 天的均线，每个画图的指标一条。

    件数类（出片数、使用人次、token 合计、片长）平均的是窗里各活跃日的日值，只在按天时有；
    其余在整个窗里重算比率或平均。补窗规则见合同 §12。
    """

    deliveries: MovingAverageOut | None
    producers: MovingAverageOut | None
    total_tokens: MovingAverageOut | None
    length_seconds: MovingAverageOut | None
    attempts_per_shot: MovingAverageOut
    one_take_rate: MovingAverageOut
    effective_rate: MovingAverageOut
    active_cycle_seconds: MovingAverageOut
    upstream_seconds: MovingAverageOut
    tokens_per_delivery: MovingAverageOut
    input_tokens_per_delivery: MovingAverageOut
    output_tokens_per_delivery: MovingAverageOut
    cache_write_tokens_per_delivery: MovingAverageOut
    cache_read_tokens_per_delivery: MovingAverageOut


class TrendPointOut(CamelModel):
    """趋势的一期。按周时首期从所在周的周一算起，指标仍只统计时间窗内。"""

    period_start: datetime
    inactive: bool
    metrics: MetricsOut
    ma7: MovingAveragesOut | None
    ma30: MovingAveragesOut | None


class TopShotOut(CamelModel):
    """时间窗里成功生成次数最多的镜之一；时间窗作用在该镜第一条成功生成的完成时刻上。"""

    conversation_id: uuid.UUID
    title: str
    user_name: str | None
    shot: int
    attempts: int


class OverviewOut(CamelModel):
    window: OverviewWindowOut
    current: OverviewPeriodOut
    previous: OverviewPeriodOut
    series: list[TrendPointOut]
    attempt_distribution: list[AttemptBucketOut]
    top_shots: list[TopShotOut]


class ModelUsageOut(CamelModel):
    model_name: str
    usage: UsageOut


class PeriodDeliveriesOut(CamelModel):
    period_start: datetime
    deliveries: int


class PersonOut(CamelModel):
    """一个人在时间窗里的指标；出片数同一需求单只算一件，没挂需求单的有出片对话各算一件。"""

    user_name: str
    metrics: MetricsOut
    trend: list[PeriodDeliveriesOut]


class AuditPeopleOut(CamelModel):
    bucket: OverviewBucket
    items: list[PersonOut]


class ExecutionShotOut(CamelModel):
    """这段对话里至少成功生成过一条的镜。"""

    shot: int
    attempts: int
    one_take: bool
    effective: bool


class ExecutionThresholdsOut(CamelModel):
    """四种异常的门槛。"""

    retry_at_least: int
    stuck_hours: int
    spend_times: int
    task_conversations: int
    spend_tokens: float | None


class ExecutionOut(CamelModel):
    """一次任务执行，即一段有运行或出片的对话；指标、镜与用量是这段对话的全量，不按时间窗裁。"""

    conversation_id: uuid.UUID
    title: str
    user_name: str | None
    task_id: uuid.UUID | None
    task_title: str | None
    created_at: datetime
    started_at: datetime
    delivered_at: datetime | None
    deleted_at: datetime | None
    metrics: MetricsOut
    shots: list[ExecutionShotOut]
    usage: list[ModelUsageOut]
    anomalies: list[ExecutionAnomalyKind]


class AuditExecutionsOut(CamelModel):
    items: list[ExecutionOut]
    next_cursor: str | None
    total: int
    flagged: int
    thresholds: ExecutionThresholdsOut


__all__ = [
    "EMPTY_METRICS",
    "NO_USAGE",
    "AttemptBucketOut",
    "AuditExecutionsOut",
    "AuditPeopleOut",
    "ExecutionOut",
    "ExecutionShotOut",
    "ExecutionThresholdsOut",
    "MetricsOut",
    "ModelUsageOut",
    "MovingAverageOut",
    "MovingAveragesOut",
    "OverviewOut",
    "OverviewPeriodOut",
    "OverviewWindowOut",
    "PeriodDeliveriesOut",
    "PeriodMetricsOut",
    "PersonOut",
    "SpreadOut",
    "TopShotOut",
    "TrendPointOut",
    "UsageOut",
]
