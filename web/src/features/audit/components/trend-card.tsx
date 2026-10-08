/** 首屏的一张趋势卡：标题（点了滚到下面对应的一节）与 ⓘ、数字与环比，下面一张趋势图。 */

import { useId, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { EMPTY } from '../overview-format'
import type { CardHead, ChartModel } from '../overview-model'
import { Card, DeltaText, InfoTip } from './overview-bits'
import { OverviewChart } from './overview-chart'

type TrendCardProps = {
  title: string
  info: string
  head: CardHead
  /** 环比悬停时写的「与 X–Y 相比」。 */
  deltaTitle: string
  model: ChartModel
  /** 标题点了滚到的那一节。 */
  onJump: () => void
  /** 标题右侧的图例，如 token 的分项。 */
  legend?: ReactNode
  className?: string
}

export function TrendCard({
  title,
  info,
  head,
  deltaTitle,
  model,
  onJump,
  legend,
  className,
}: TrendCardProps) {
  const titleId = useId()
  return (
    <Card
      aria-labelledby={titleId}
      className={cn(
        'group/card relative flex min-h-85 flex-col gap-1.5 px-5 pt-4.5 pb-2.5 lg:min-h-0',
        className,
      )}
      role="article"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center">
          <h3
            className="text-body font-medium whitespace-nowrap text-on-surface-muted"
            id={titleId}
          >
            <button
              className="-mx-1 -my-0.5 inline-flex ui-state cursor-pointer items-center gap-0.5 rounded-sm px-1 py-0.5 ui-focus hover:text-on-surface"
              onClick={onJump}
              title="点击可查看下方该项的分布"
              type="button"
            >
              {title}
              <span
                aria-hidden
                className="text-title leading-none opacity-0 transition-opacity ui-motion-s group-hover/card:opacity-100"
              >
                ›
              </span>
            </button>
          </h3>
          <InfoTip text={info} />
        </div>
        {/* 宽屏上图例贴右上角，折成两行也不把数字那一行往下挤，同一排的卡片数字对齐。 */}
        {legend === undefined ? null : (
          <div className="lg:absolute lg:top-4.5 lg:right-5 lg:max-w-[55%]">{legend}</div>
        )}
      </div>
      <p className="flex min-w-0 items-baseline gap-1.5" title={head.detail}>
        <span className="text-headline-lg font-semibold tracking-tight whitespace-nowrap text-on-surface tabular-nums">
          {head.value}
        </span>
        {head.value === EMPTY ? null : (
          <span className="text-body font-medium whitespace-nowrap text-on-surface-muted">
            {head.unit}
          </span>
        )}
        {head.delta === null ? null : (
          <DeltaText className="ml-1.5" delta={head.delta} title={deltaTitle} />
        )}
        {head.aside === null ? null : (
          <span className="ml-2.5 text-label whitespace-nowrap text-on-surface-muted">
            {head.aside}
          </span>
        )}
      </p>
      <OverviewChart className="mt-1 flex-1" label={title} model={model} />
    </Card>
  )
}
