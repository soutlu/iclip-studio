"""审计报表的读模型：一格指标、按时段分行的指标、总览、按人与任务执行，直接就是各端点的响应。

只读报表没有写路径也没有行为，领域模型与出口形状是同一个东西，不再各存一份互相搬运。
camelCase 别名；比率在这里由原始计数派生，分母为零时是 ``None``。口径的定义见
docs/CONTEXT.md「审计口径」。"""

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
    """样本数。"""


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
    """镜数：至少成功生成过一条的镜；一条都没成的不算镜。"""
    attempts: int
    """这些镜的成功生成次数合计；失败与还没出结果的不计。"""
    one_take_shots: int
    """一次通过的镜数：只用一次成功生成就达标的镜；失败的不算。"""
    effective_shots: int
    """有效镜数：有人下载过的镜；下载的是衍生记录时，按原作号算到原作所在的镜。"""
    runs: int
    """agent 运行次数，按发起人归属。"""
    active_users: int
    """发起过运行的人数；按天为 0 即非活跃日。"""
    delivered_conversations: int
    cycle_seconds: SpreadOut | None
    """对话交付周期：首次运行到最后一条成片，含中间的空档。"""
    active_cycle_seconds: SpreadOut | None
    """单任务时长：同一区间里只算 agent 运行与视频生成的时段，相隔超过 30 分钟的空档不计。"""
    agent_run_seconds: SpreadOut | None
    """agent 一轮运行从开始到结束；没结束的轮不计。"""
    upstream_seconds: SpreadOut | None
    """单个视频提交上游到完成。"""
    length_videos: int
    """有片长的成片条数；片长读生成记录的 ``duration_ms``，为空的不计。"""
    length_seconds: float
    """成片片长合计。"""
    discarded_length_seconds: float
    """其中废片的片长：同一镜成功过多条时，除最后一条以外的。"""
    usage: UsageOut

    @computed_field
    @property
    def deliveries(self) -> int:
        """成片件数：有成片的需求单各一件，加没挂需求单却有成片的对话各一件。"""

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
    """晚于此刻的按此刻算。"""
    previous_since: datetime
    previous_until: datetime
    bucket: OverviewBucket
    timezone: str
    generated_at: datetime
    """数据截至的时刻。"""


class OverviewPeriodOut(CamelModel):
    """一期的整段指标，分位数按整段现算，不由各期拼。"""

    metrics: MetricsOut
    active_days: int
    """这一期里的活跃日天数。"""


class MovingAverageOut(CamelModel):
    """一条均线在某一期的值与它实际覆盖的时间窗；窗往前补过时 ``since`` 比名义起点早。"""

    value: float | None
    """窗里没有样本时为空。"""
    since: datetime
    until: datetime


class MovingAveragesOut(CamelModel):
    """一期末尾往前推 7 或 30 天的均线，每个画图的指标一条。

    件数类（成片数、使用人次、token 合计、片长）平均的是窗里各活跃日的日值，只在按天时有；
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
    """单任务时长的平均。"""
    upstream_seconds: MovingAverageOut
    """视频生成时长的平均。"""
    tokens_per_delivery: MovingAverageOut
    input_tokens_per_delivery: MovingAverageOut
    output_tokens_per_delivery: MovingAverageOut
    cache_write_tokens_per_delivery: MovingAverageOut
    cache_read_tokens_per_delivery: MovingAverageOut


class TrendPointOut(CamelModel):
    """趋势的一期。按周时首期从所在周的周一算起，指标仍只统计时间窗内。"""

    period_start: datetime
    inactive: bool
    """这一天没有人发起运行；只在按天时可能为真。"""
    metrics: MetricsOut
    ma7: MovingAveragesOut | None
    """按周时为空。"""
    ma30: MovingAveragesOut | None
    """按周时为空。"""


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
    """早的在前；时间窗内每一期都在，没数据的期计数为 0。"""
    attempt_distribution: list[AttemptBucketOut]
    """本期的成功生成次数分布，次数少的在前，不封顶。"""
    top_shots: list[TopShotOut]
    """本期成功生成次数最多的 3 个镜，多的在前。"""


class ModelUsageOut(CamelModel):
    model_name: str
    usage: UsageOut


class PeriodDeliveriesOut(CamelModel):
    period_start: datetime
    deliveries: int


class PersonOut(CamelModel):
    """一个人在时间窗里的指标；成片数同一需求单只算一件，没挂需求单的有成片对话各算一件。"""

    user_name: str
    metrics: MetricsOut
    trend: list[PeriodDeliveriesOut]
    """时间窗内每一期的成片数，早的在前，每期都在；粒度见 ``AuditPeopleOut.bucket``。"""


class AuditPeopleOut(CamelModel):
    bucket: OverviewBucket
    """``trend`` 的粒度，与总览同一规则。"""
    items: list[PersonOut]
    """时间窗里出过片或跑过的人，一次全给，成片多的在前。"""


class ExecutionShotOut(CamelModel):
    """这段对话里至少成功生成过一条的镜。"""

    shot: int
    attempts: int
    """成功生成次数。"""
    one_take: bool
    effective: bool
    """有人下载过这一镜的出片，或挂在它们名下的衍生记录。"""


class ExecutionThresholdsOut(CamelModel):
    """四种异常的门槛。"""

    retry_at_least: int
    """单镜成功生成达到这么多次算反复重试。"""
    stuck_hours: int
    """提交上游超过这么多小时还没结果算视频悬挂。"""
    spend_times: int
    task_conversations: int
    """需求单在时间窗里挂了至少这么多段执行、且从来没有过成片算卡住。"""
    spend_tokens: float | None
    """本期消耗离群的门槛：本期每件成片平均 token × ``spend_times``；本期没有成片时为空。"""


class ExecutionOut(CamelModel):
    """一次任务执行，即一段有运行或出片的对话；指标、镜与用量是这段对话的全量，不按时间窗裁。"""

    conversation_id: uuid.UUID
    title: str
    user_name: str | None
    task_id: uuid.UUID | None
    task_title: str | None
    created_at: datetime
    started_at: datetime
    """首次运行时刻，没有运行就是建立时刻；只用来显示，筛选与排序用 ``created_at``。"""
    delivered_at: datetime | None
    """最后一条成片的时刻；还没有成片为空。"""
    deleted_at: datetime | None
    metrics: MetricsOut
    shots: list[ExecutionShotOut]
    usage: list[ModelUsageOut]
    """按模型的用量。"""
    anomalies: list[ExecutionAnomalyKind]


class AuditExecutionsOut(CamelModel):
    items: list[ExecutionOut]
    next_cursor: str | None
    total: int
    """筛选范围里的任务执行总数。"""
    flagged: int
    """其中至少命中一种异常的条数。"""
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
