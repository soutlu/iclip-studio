/** 总览：工具条定时间，首屏五张趋势卡撑满一屏，往下是出片质量、耗时、模型消耗、使用人次各节的图。 */

import { useId } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { ListError } from '@/shared/ui/list-state'
import { useAuditOverview, type Overview } from '../audit.api'
import { fmtDayRange } from '../overview-format'
import { cardHead, chartModel, TOKEN_PARTS, type CardKey } from '../overview-model'
import type { OverviewRange } from '../overview-range'
import { Card, InfoTip, LegendItem, Mark } from './overview-bits'
import { CostSection, ProducersSection, QualitySection, SpeedSection } from './overview-sections'
import { OverviewToolbar } from './overview-toolbar'
import { TrendCard } from './trend-card'

type OverviewPanelProps = {
  range: OverviewRange
  onRangeChange: (next: OverviewRange) => void
  /** 上游归属用户名 → 显示名；名册里没有就原样显示。 */
  nameOf: (userName: string) => string | undefined
}

type SectionKey = 'quality' | 'speed' | 'cost' | 'output'

const CARDS: readonly {
  key: CardKey
  info: string
  section: SectionKey
  wide?: boolean
}[] = [
  {
    key: 'deliveries',
    info: '有成片的需求单各计为 1 件；未关联需求单、但有成片的对话各计为 1 件。环比按活跃日的日均值计算。',
    section: 'output',
  },
  {
    key: 'attempts',
    info: '一个镜头指一段对话中的一个镜号。统计平均每个镜头成功生成的次数，失败的不计费、不计入；从未成功生成的镜头不计入。越接近 1 越好。',
    section: 'quality',
  },
  {
    key: 'cycle',
    info: '统计一段对话从首次运行到最后一条成片的时长，仅计 agent 运行或视频生成的时间，取平均值。中途间隔超过 30 分钟的部分不计入，30 分钟以内的照常计入。',
    section: 'speed',
  },
  {
    key: 'effective',
    info: '有人下载过的镜头数 ÷ 镜头总数。下载的是合成视频时，按原作计入原作所在的镜头。',
    section: 'quality',
    wide: true,
  },
  {
    key: 'perDelivery',
    info: '模型 token 合计 ÷ 成片件数，按输入、输出、缓存写入、缓存读取分项统计。标题生成、压缩摘要、视频理解不计入。',
    section: 'cost',
    wide: true,
  },
]

const CARD_LABEL: Record<CardKey, string> = {
  deliveries: '成片数',
  attempts: '每镜头重试次数',
  cycle: '单任务平均时长',
  effective: '素材有效率',
  perDelivery: '每件成片 · token',
}

const BUCKET_UNIT = { hour: '小时', day: '天', week: '周' } as const

/** 均线窗里不够这么多活跃日、镜、件就往前补；数字与服务端的补窗规则一致，只用在说明里。 */
const AVERAGE_INFO =
  '当天往前 7 天 / 30 天（含当天）的平均值。件数仅按活跃日平均；比率与中位数在该时间段内重新计算。该时间段内不足 3 个活跃日、或不足 30 镜 / 10 件时，继续向前补足。'

export function OverviewPanel({ range, onRangeChange, nameOf }: OverviewPanelProps) {
  const overview = useAuditOverview(range)
  const baseId = useId()
  const sectionId = (key: SectionKey) => `${baseId}-${key}`
  const jumpTo = (key: SectionKey) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document
      .getElementById(sectionId(key))
      ?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }
  const data = overview.data

  return (
    <div className="flex flex-col gap-4">
      <OverviewToolbar onChange={onRangeChange} range={range}>
        {data === undefined ? null : (
          <span className="text-label whitespace-nowrap text-on-surface-muted">
            环比对比{' '}
            {fmtDayRange(new Date(data.window.previousSince), new Date(data.window.previousUntil))}
          </span>
        )}
      </OverviewToolbar>
      {overview.isError && data === undefined ? (
        <ListError
          message={errorMessageOf(overview.error, '读取审计总览失败')}
          onRetry={() => void overview.refetch()}
        />
      ) : data === undefined ? (
        <OverviewSkeleton />
      ) : (
        <div
          aria-busy={overview.isPlaceholderData}
          className="flex flex-col gap-3 transition-opacity ui-motion-s aria-busy:opacity-60"
        >
          <Legend overview={data} />
          <section
            aria-label="业务趋势"
            className="grid grid-cols-1 gap-4 lg:h-[clamp(540px,calc(100dvh-228px),860px)] lg:grid-cols-6 lg:grid-rows-2"
          >
            {CARDS.map((card) => (
              <OverviewCard
                card={card}
                key={card.key}
                onJump={() => jumpTo(card.section)}
                overview={data}
              />
            ))}
          </section>
          <QualitySection id={sectionId('quality')} nameOf={nameOf} overview={data} />
          <SpeedSection id={sectionId('speed')} overview={data} />
          <CostSection id={sectionId('cost')} overview={data} />
          <ProducersSection id={sectionId('output')} overview={data} />
        </div>
      )}
    </div>
  )
}

function OverviewCard({
  card,
  overview,
  onJump,
}: {
  card: (typeof CARDS)[number]
  overview: Overview
  onJump: () => void
}) {
  const previousRange = fmtDayRange(
    new Date(overview.window.previousSince),
    new Date(overview.window.previousUntil),
  )
  const { bucket } = overview.window
  // token 卡的分项图例放在标题右侧，不另占一行；按周没有均线，也就没有「当天合计」的点。
  const legend =
    card.key === 'perDelivery' ? (
      <div className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-caption text-on-surface-muted">
        {TOKEN_PARTS.map((part) => (
          <LegendItem key={part.name} marks={<Mark color={part.color} kind="swatch" />}>
            {part.name}
          </LegendItem>
        ))}
        {bucket === 'week' ? null : (
          <LegendItem marks={<Mark color="var(--color-on-surface-variant)" kind="dot" />}>
            {bucket === 'day' ? '当天合计' : '这小时合计'}
          </LegendItem>
        )}
      </div>
    ) : undefined
  return (
    <TrendCard
      className={card.wide === true ? 'lg:col-span-3' : 'lg:col-span-2'}
      deltaTitle={`与 ${previousRange} 相比`}
      head={cardHead(card.key, overview, previousRange)}
      info={card.info}
      legend={legend}
      model={chartModel(overview, card.key)}
      onJump={onJump}
      title={CARD_LABEL[card.key]}
    />
  )
}

/** 总览上所有图共用一套读法；只列这一屏上真的出现了的项，口径收进 ⓘ。 */
function Legend({ overview }: { overview: Overview }) {
  const { bucket } = overview.window
  const inactive = bucket === 'day' && overview.series.some((point) => point.inactive)
  return (
    <div
      aria-label="图例"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-on-surface-muted"
      role="group"
    >
      <LegendItem
        marks={
          <>
            <Mark kind="bar" />
            <Mark kind="dot" />
          </>
        }
      >
        每{BUCKET_UNIT[bucket]}
      </LegendItem>
      {bucket === 'day' ? (
        <>
          <LegendItem
            marks={
              <>
                <Mark kind="average" />
                <Mark kind="line" />
              </>
            }
          >
            7 日均线
            <InfoTip text={AVERAGE_INFO} />
          </LegendItem>
          <LegendItem marks={<Mark kind="dash" />}>30 日均线</LegendItem>
        </>
      ) : null}
      {bucket === 'hour' ? (
        <>
          <LegendItem marks={<Mark kind="line" />}>7 日均线</LegendItem>
          <LegendItem marks={<Mark kind="dash" />}>
            30 日均线
            <InfoTip text={`按小时统计时，仅比率类指标显示均线。${AVERAGE_INFO}`} />
          </LegendItem>
        </>
      ) : null}
      {inactive ? (
        <LegendItem marks={<Mark kind="inactive" />}>
          非活跃日
          <InfoTip text="当天无人发起运行。均线和日均仅计算活跃日。" />
        </LegendItem>
      ) : null}
    </div>
  )
}

/** 首次读取时的骨架：五张卡的位置先占住，数据到了不跳。 */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <p className="sr-only" role="status">
        正在读取审计总览
      </p>
      <div
        aria-hidden
        className="grid grid-cols-1 gap-4 motion-safe:animate-pulse lg:h-[clamp(540px,calc(100dvh-228px),860px)] lg:grid-cols-6 lg:grid-rows-2"
      >
        {CARDS.map((card) => (
          <Card
            className={cn(
              'flex min-h-85 flex-col gap-3 px-5 py-4.5 lg:min-h-0',
              card.wide === true ? 'lg:col-span-3' : 'lg:col-span-2',
            )}
            key={card.key}
          >
            <span className="h-3.5 w-24 rounded-full bg-state-active" />
            <span className="h-8 w-20 rounded-full bg-state-active" />
            <span className="mt-2 flex-1 rounded-md bg-state-active" />
          </Card>
        ))}
      </div>
    </div>
  )
}
