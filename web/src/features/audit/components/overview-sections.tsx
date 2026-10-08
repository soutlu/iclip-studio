/** 总览首屏以下的四节：出片质量、耗时、模型消耗、使用人次。 */

import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import type { Metrics, Overview } from '../audit.api'
import {
  EMPTY,
  fmtCount,
  fmtDayRange,
  fmtDuration,
  fmtLength,
  fmtRate,
  fmtTokens,
  lengthParts,
} from '../overview-format'
import {
  attemptSummary,
  ATTEMPT_BINS,
  chartModel,
  RETRY_AT_LEAST,
  relativeDelta,
  TOKEN_PARTS,
} from '../overview-model'
import { AttemptBars } from './attempt-bars'
import { Card, DeltaText, InfoTip, LegendItem, Mark, Section } from './overview-bits'
import { OverviewChart } from './overview-chart'

type SectionProps = { id: string; overview: Overview }

/** 各节里的一张卡；按自身宽度（容器查询）决定分项图例摆一列还是两列。 */
function Panel({ children }: { children: ReactNode }) {
  return <Card className="@container px-5.5 py-5">{children}</Card>
}

function MiniHead({ title, info, end }: { title: string; info?: string; end?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h4 className="flex shrink-0 items-center text-title font-semibold text-on-surface">
        {title}
        {info === undefined ? null : <InfoTip text={info} />}
      </h4>
      {end}
    </div>
  )
}

const deltaTitleOf = (overview: Overview) =>
  `与 ${fmtDayRange(new Date(overview.window.previousSince), new Date(overview.window.previousUntil))} 相比`

// ——— 出片质量 ———

export function QualitySection({
  id,
  overview,
  nameOf,
}: SectionProps & { nameOf: (userName: string) => string | undefined }) {
  const summary = attemptSummary(overview.attemptDistribution)
  const within = summary.shotShares.slice(0, RETRY_AT_LEAST).reduce((sum, share) => sum + share, 0)
  return (
    <Section
      id={id}
      info="仅统计成功生成且带镜号的出片，失败的不计费、不计入；一个镜头指一段对话中的一个镜号，从未成功生成的镜头不计入。"
      title="出片质量"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <MiniHead info="每成功生成一条计为 1 次，失败的不计入" title="每个镜出了几次" />
          <p className="mt-0.5 mb-2.5 text-body text-on-surface-variant">
            {summary.totalShots === 0 ? (
              '所选时间范围内暂无新镜头'
            ) : (
              <>
                <b className="font-semibold text-on-surface">
                  {fmtRate(summary.shotShares[0] ?? 0)}
                </b>{' '}
                的镜头仅出片 1 次，
                <b className="font-semibold text-on-surface">{fmtRate(within)}</b> 不超过{' '}
                {RETRY_AT_LEAST} 次
              </>
            )}
          </p>
          <AttemptBars summary={summary} />
        </Panel>
        <Panel>
          <MiniHead title="出片次数都花在哪" />
          <ReworkShare nameOf={nameOf} overview={overview} summary={summary} />
        </Panel>
      </div>
      <Panel>
        <MiniHead
          info="仅需一次成功生成即达标的镜头占镜头总数的比例。失败的生成不计入。"
          title="一次通过率"
        />
        <OverviewChart height={200} label="一次通过率" model={chartModel(overview, 'oneTake')} />
      </Panel>
    </Section>
  )
}

/** 两条对照的占比条：上一条是各档占镜数，下一条是占出片次数（成功生成次数）；下面点名出片次数最多的镜。 */
function ReworkShare({
  overview,
  summary,
  nameOf,
}: {
  overview: Overview
  summary: ReturnType<typeof attemptSummary>
  nameOf: (userName: string) => string | undefined
}) {
  if (summary.totalShots === 0) {
    return (
      <p className="mt-0.5 mb-2.5 text-body text-on-surface-variant">所选时间范围内暂无新镜头</p>
    )
  }
  // 段宽不到一成就不在段里写字，靠悬停和图例。
  const bar = (shares: readonly number[]) =>
    ATTEMPT_BINS.map((bin, index) => {
      const share = shares[index] ?? 0
      return (
        <i
          className="flex min-w-0 items-center justify-center text-label font-semibold not-italic"
          key={bin.name}
          style={{ background: bin.color, color: bin.ink, flex: `${share} 0 0` }}
          title={`${bin.name}：${fmtRate(share)}`}
        >
          {share >= 0.1 ? fmtRate(share) : ''}
        </i>
      )
    })
  return (
    <>
      <p className="mt-0.5 mb-2.5 text-body text-on-surface-variant">
        {summary.heavy === null ? (
          `暂无出片 ${RETRY_AT_LEAST} 次及以上的镜头`
        ) : (
          <>
            出片 {RETRY_AT_LEAST} 次及以上的镜头占{' '}
            <b className="font-semibold text-on-surface">{fmtRate(summary.heavy.shotShare)}</b>
            ，消耗了{' '}
            <b className="font-semibold text-on-surface">
              {fmtRate(summary.heavy.attemptShare)}
            </b>{' '}
            的出片次数
          </>
        )}
      </p>
      <div className="mt-2 flex flex-col gap-2.5">
        {[
          { label: '占镜数', shares: summary.shotShares },
          { label: '占出片次数', shares: summary.attemptShares },
        ].map((row) => (
          <div
            className="grid grid-cols-[64px_1fr] items-center gap-3 text-label text-on-surface-muted"
            key={row.label}
          >
            <span>{row.label}</span>
            <div className="flex h-7.5 gap-0.5 overflow-hidden rounded-sm">{bar(row.shares)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-on-surface-muted sm:ml-19">
        {ATTEMPT_BINS.map((bin) => (
          <LegendItem key={bin.name} marks={<Mark color={bin.color} kind="swatch" />}>
            出了 {bin.name}
          </LegendItem>
        ))}
      </div>
      {overview.topShots.length === 0 ? null : (
        <div className="mt-3.5 border-t border-hairline pt-3">
          <h5 className="mb-1 text-label font-medium text-on-surface-muted">出片次数最多的镜</h5>
          <ol>
            {overview.topShots.map((shot) => {
              const who = shot.userName === null ? null : (nameOf(shot.userName) ?? shot.userName)
              return (
                <li
                  className="flex justify-between gap-3 py-1 text-body text-on-surface-variant"
                  key={`${shot.conversationId}:${shot.shot}`}
                >
                  <span className="min-w-0 truncate">
                    {who === null ? shot.title : `${who} · ${shot.title}`}
                  </span>
                  <b className="shrink-0 font-semibold text-on-surface tabular-nums">
                    {shot.attempts} 次
                  </b>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </>
  )
}

// ——— 耗时 ———

const SPAN_ROWS: readonly {
  name: string
  hint: string
  pick: (metrics: Metrics) => Metrics['activeCycleSeconds']
}[] = [
  {
    name: '单任务平均时长',
    hint: '从首次运行到最后一条成片，仅计运行中的时间',
    pick: (m) => m.activeCycleSeconds,
  },
  {
    name: 'agent 平均运行时长',
    hint: '一轮从开始运行到回复完成，不含排队和等待审批的时间',
    pick: (m) => m.agentRunSeconds,
  },
  { name: '视频生成平均时长', hint: '从提交上游到返回结果', pick: (m) => m.upstreamSeconds },
]

export function SpeedSection({ id, overview }: SectionProps) {
  const metrics = overview.current.metrics
  return (
    <Section
      id={id}
      info="中位：一半样本在此时长以内；最慢一成：最慢 10% 样本的分界线。单任务平均时长仅计运行中的时间，中途间隔超过 30 分钟的部分不计入。"
      title="耗时"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <MiniHead
            end={
              <span className="text-label text-on-surface-muted">
                样本：{metrics.activeCycleSeconds?.count ?? 0} 段对话 ·{' '}
                {metrics.agentRunSeconds?.count ?? 0} 轮 agent ·{' '}
                {metrics.upstreamSeconds?.count ?? 0} 条视频
              </span>
            }
            title="耗时分布"
          />
          <div className="mt-3 flex flex-col gap-3.5">
            {SPAN_ROWS.map((row) => (
              <SpanRow hint={row.hint} key={row.name} name={row.name} spread={row.pick(metrics)} />
            ))}
          </div>
          <div className="mt-2.5 flex gap-4 text-label text-on-surface-variant">
            <LegendItem marks={<SpanMark kind="median" />}>中位</LegendItem>
            <LegendItem marks={<SpanMark kind="avg" />}>平均</LegendItem>
            <LegendItem marks={<SpanMark kind="p90" />}>最慢一成</LegendItem>
          </div>
        </Panel>
        <Panel>
          <MiniHead info="一条视频从提交上游到返回结果的时长，取平均值" title="视频生成平均时长" />
          <OverviewChart
            height={200}
            label="视频生成平均时长"
            model={chartModel(overview, 'upstream')}
          />
        </Panel>
      </div>
    </Section>
  )
}

function SpanMark({
  kind,
  className,
  style,
}: {
  kind: 'median' | 'avg' | 'p90'
  className?: string
  style?: CSSProperties
}) {
  return (
    <i
      aria-hidden
      className={cn(
        'block shrink-0',
        kind === 'median' && 'size-3 rounded-full bg-chart-1 ring-2 ring-dashboard-card',
        kind === 'avg' && 'size-3 rounded-full border-2 border-primary bg-dashboard-card',
        kind === 'p90' && 'h-4 w-0.75 rounded-xs bg-on-surface-variant',
        className,
      )}
      style={style}
    />
  )
}

/** 一段用时的区间轨：中位到最慢一成铺淡色，三个标签依次放上排或下排，同排相距不足两成就换排。 */
function SpanRow({
  name,
  hint,
  spread,
}: {
  name: string
  hint: string
  spread: Metrics['activeCycleSeconds']
}) {
  const title = (
    <div className="text-body font-semibold text-on-surface">
      {name}
      <small className="block text-caption font-normal text-on-surface-muted">{hint}</small>
    </div>
  )
  if (spread === null) {
    return (
      <div className="grid grid-cols-1 items-center gap-1 md:grid-cols-[148px_1fr] md:gap-4">
        {title}
        <p className="text-label text-on-surface-muted">暂无样本</p>
      </div>
    )
  }
  const max = Math.max(spread.p90, spread.avg) * 1.12
  const at = (value: number) => (max === 0 ? 0 : Math.min(100, (value / max) * 100))
  const placed: number[] = []
  const labels = (
    [
      ['中位', spread.median],
      ['最慢一成', spread.p90],
      ['平均', spread.avg],
    ] as const
  ).map(([text, value]) => {
    const position = at(value)
    const top = placed.every((other) => Math.abs(other - position) >= 22)
    if (top) placed.push(position)
    const shift = position < 10 ? '0' : position > 90 ? '-100%' : '-50%'
    return (
      <span
        className="absolute text-caption whitespace-nowrap text-on-surface-variant"
        key={text}
        style={{ left: `${position}%`, top: top ? 4 : 40, transform: `translateX(${shift})` }}
      >
        {text} <b className="font-semibold text-on-surface">{fmtDuration(value)}</b>
      </span>
    )
  })
  return (
    <div className="grid grid-cols-1 items-center gap-1 md:grid-cols-[148px_1fr] md:gap-4">
      {title}
      <div className="relative h-14">
        <div className="absolute inset-x-0 top-6.5 h-1.5 rounded-full bg-state-active" />
        <div
          className="absolute top-6.5 h-1.5 rounded-full bg-chart-1 opacity-35"
          style={{ left: `${at(spread.median)}%`, width: `${at(spread.p90) - at(spread.median)}%` }}
        />
        {labels}
        <SpanMark
          className="absolute top-5.25 -ml-0.5"
          kind="p90"
          style={{ left: `${at(spread.p90)}%` }}
        />
        <SpanMark
          className="absolute top-5.75 -ml-1.5"
          kind="avg"
          style={{ left: `${at(spread.avg)}%` }}
        />
        <SpanMark
          className="absolute top-5.75 -ml-1.5"
          kind="median"
          style={{ left: `${at(spread.median)}%` }}
        />
      </div>
    </div>
  )
}

// ——— 模型消耗 ———

const BUCKET_WORD = { hour: '每小时', day: '每日', week: '每周' } as const

export function CostSection({ id, overview }: SectionProps) {
  const { bucket } = overview.window
  const current = overview.current.metrics
  const previous = overview.previous.metrics
  const deltaTitle = deltaTitleOf(overview)
  const hasLength = current.lengthVideos > 0
  const [lengthValue, lengthUnit] = lengthParts(current.lengthSeconds)
  const finalLength = current.lengthSeconds - current.discardedLengthSeconds
  const total = current.usage.totalTokens
  const tokenModel = chartModel(overview, 'tokens')
  return (
    <Section
      id={id}
      info="视频按成功出片的秒数统计，重新生成的也计入、失败的不计入；token 取自用量台账，标题生成、压缩摘要、视频理解不计入。"
      title="模型消耗"
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Panel>
          <MiniHead
            end={
              hasLength ? (
                <DeltaText
                  delta={relativeDelta(current.lengthSeconds, previous.lengthSeconds, 'down')}
                  title={deltaTitle}
                />
              ) : null
            }
            info="仅统计成功出片的秒数，失败的不计入。一个镜头成功生成多条时，最后一条计入最终成片长度，其余计入废片长度。"
            title="视频生成总时长"
          />
          {hasLength ? (
            <>
              <Stat
                sub={`${fmtCount(current.completedVideos)} 条成功出片，平均每条 ${fmtLength(current.lengthSeconds / current.lengthVideos)}`}
                unit={lengthUnit}
                value={lengthValue}
              />
              <StackBar
                parts={[
                  { color: 'var(--color-chart-1)', value: finalLength },
                  { color: 'var(--color-chart-3)', value: current.discardedLengthSeconds },
                ]}
              />
              <StackKeys
                items={[
                  {
                    color: 'var(--color-chart-1)',
                    name: '最终成片长度',
                    value: fmtLength(finalLength),
                  },
                  {
                    color: 'var(--color-chart-3)',
                    name: '废片长度',
                    value: fmtLength(current.discardedLengthSeconds),
                  },
                ]}
              />
            </>
          ) : (
            // 片长读生成记录的产物时长，出片暂时都是空；空就显示「—」，不拿请求秒数去猜。
            <Stat
              sub={`${fmtCount(current.completedVideos)} 条成功出片，暂无片长数据`}
              value={EMPTY}
            />
          )}
        </Panel>
        <Panel>
          <MiniHead
            end={
              <DeltaText
                delta={relativeDelta(total, previous.usage.totalTokens, 'down')}
                title={deltaTitle}
              />
            }
            title="总消耗"
          />
          <Stat
            sub={`${fmtCount(current.usage.requests)} 次模型响应`}
            unit="token"
            value={fmtTokens(total)}
          />
          <StackBar
            parts={TOKEN_PARTS.map((part) => ({ color: part.color, value: part.usage(current) }))}
          />
          <StackKeys
            items={TOKEN_PARTS.map((part) => ({
              color: part.color,
              name: `${part.name} ${fmtRate(total === 0 ? null : part.usage(current) / total)}`,
              value: fmtTokens(part.usage(current)),
            }))}
          />
        </Panel>
        <Panel>
          <MiniHead
            end={
              <DeltaText
                delta={relativeDelta(current.usage.cacheHitRate, previous.usage.cacheHitRate, 'up')}
                title={deltaTitle}
              />
            }
            info="缓存读取 ÷（输入 + 缓存读取 + 缓存写入），越高越省。"
            title="缓存命中率"
          />
          <div className="mt-2 flex items-center gap-4.5">
            <CacheRing rate={current.usage.cacheHitRate} />
            <p className="text-label leading-5 text-on-surface-muted">
              缓存读取 {fmtTokens(current.usage.cacheReadTokens)}
              <br />
              新输入 {fmtTokens(current.usage.inputTokens)}
              <br />
              缓存写入 {fmtTokens(current.usage.cacheWriteTokens)}
            </p>
          </div>
        </Panel>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Panel>
          <MiniHead
            info="成功出片按完成时刻归入对应日期"
            title={`${BUCKET_WORD[bucket]}总视频生成秒数`}
          />
          {hasLength ? (
            <OverviewChart
              height={220}
              label="总视频生成秒数"
              model={chartModel(overview, 'length')}
            />
          ) : (
            <p className="grid h-55 place-items-center text-label text-on-surface-muted">
              暂无片长数据
            </p>
          )}
        </Panel>
        <Panel>
          <MiniHead info="一段对话的用量按其最后一次记账的时刻归入对应日期" title="token 消耗" />
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-on-surface-muted">
            {TOKEN_PARTS.map((part) => (
              <LegendItem key={part.name} marks={<Mark color={part.color} kind="swatch" />}>
                {part.name}
              </LegendItem>
            ))}
            {tokenModel.hasLine ? (
              <LegendItem marks={<Mark kind="average" />}>7 日均线</LegendItem>
            ) : null}
            {tokenModel.hasSlow ? (
              <LegendItem marks={<Mark kind="dash" />}>30 日均线</LegendItem>
            ) : null}
          </div>
          <OverviewChart height={220} label="token 消耗" model={tokenModel} />
        </Panel>
      </div>
    </Section>
  )
}

function Stat({ value, unit, sub }: { value: string; unit?: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-headline font-semibold tracking-tight text-on-surface tabular-nums">
        {value}
        {unit === undefined || value === EMPTY ? null : (
          <small className="ml-1.5 text-body font-medium text-on-surface-variant">{unit}</small>
        )}
      </span>
      <span className="text-label text-on-surface-muted">{sub}</span>
    </div>
  )
}

function StackBar({ parts }: { parts: readonly { color: string; value: number }[] }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  return (
    <div aria-hidden className="mt-3 mb-2.5 flex h-3 gap-0.5 overflow-hidden rounded-full">
      {parts.map((part) => (
        <i
          className="block h-full"
          key={part.color}
          style={{
            background: part.color,
            width: `${total === 0 ? 0 : (part.value / total) * 100}%`,
          }}
        />
      ))}
    </div>
  )
}

function StackKeys({
  items,
}: {
  items: readonly { color: string; name: string; value: string }[]
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-label @[20rem]:grid-cols-2">
      {items.map((item) => (
        <span
          className="flex items-center gap-1.5 whitespace-nowrap text-on-surface-variant"
          key={item.color}
        >
          <Mark color={item.color} kind="swatch" />
          {item.name}
          <b className="ml-auto font-semibold text-on-surface tabular-nums">{item.value}</b>
        </span>
      ))}
    </div>
  )
}

/** 缓存命中率的圆环：底圈是中性浅色，命中部分用图表绿。 */
function CacheRing({ rate }: { rate: number | null }) {
  const circumference = 2 * Math.PI * 34
  return (
    <div className="relative size-21 shrink-0">
      <svg aria-hidden className="-rotate-90" height={84} viewBox="0 0 84 84" width={84}>
        <circle
          cx={42}
          cy={42}
          fill="none"
          r={34}
          stroke="var(--color-state-active)"
          strokeWidth={9}
        />
        <circle
          cx={42}
          cy={42}
          fill="none"
          r={34}
          stroke="var(--color-chart-1)"
          strokeDasharray={`${circumference * (rate ?? 0)} ${circumference}`}
          strokeLinecap="round"
          strokeWidth={9}
        />
      </svg>
      <b className="absolute inset-0 grid place-items-center text-title font-semibold text-on-surface">
        {fmtRate(rate)}
      </b>
    </div>
  )
}

// ——— 使用人次 ———

export function ProducersSection({ id, overview }: SectionProps) {
  const current = overview.current.metrics
  return (
    <Section
      aside={
        <span className="text-label text-on-surface-muted">
          {current.producers === 0
            ? '所选时间范围内暂无人出片'
            : `所选时间范围内共 ${current.producers} 人出片，人均 ${(current.deliveries / current.producers).toFixed(1)} 件`}
        </span>
      }
      id={id}
      info="所选时间范围内出过片的人"
      title="使用人次"
    >
      <Panel>
        <OverviewChart height={180} label="使用人次" model={chartModel(overview, 'producers')} />
      </Panel>
    </Section>
  )
}
