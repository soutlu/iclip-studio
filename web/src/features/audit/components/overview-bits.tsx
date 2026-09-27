/** 总览里反复出现的小件：卡片外壳、标题旁的 ⓘ、环比字、图例记号。 */

import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { Delta } from '../overview-model'

/** 内容区铺浅灰、卡片纯白不描边，靠一层淡影分层。 */
export function Card({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg border border-dashboard-card-edge bg-dashboard-card shadow-[var(--shadow-dashboard-card)]',
        className,
      )}
      {...props}
    />
  )
}

/** 口径说明收进标题旁的小图标，悬停或聚焦才看；页面上只留读数与结论。 */
export function InfoTip({ text }: { text: string }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <button
          aria-label={text}
          className="ml-1 inline-grid size-4 shrink-0 cursor-help place-items-center rounded-full align-[-3px] text-on-surface-muted opacity-70 ui-focus hover:text-on-surface hover:opacity-100"
          type="button"
        >
          <Icon decorative name="info" size="sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-70 rounded-md px-3 py-2.5 text-body-sm">
        {text}
      </TooltipContent>
    </TooltipRoot>
  )
}

const TONE_CLASS = {
  good: 'font-semibold text-primary',
  bad: 'font-semibold text-error',
  flat: 'font-medium text-on-surface-muted',
} as const satisfies Record<Delta['tone'], string>

/** 环比只用带方向的彩色字，不套底色胶囊；悬停写明和哪几天比。 */
export function DeltaText({
  delta,
  title,
  className,
}: {
  delta: Delta
  title: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.75 text-label whitespace-nowrap',
        TONE_CLASS[delta.tone],
        className,
      )}
      title={title}
    >
      {delta.direction === null ? null : (
        <>
          <svg aria-hidden className="size-2.25 fill-current" viewBox="0 0 10 10">
            <path d={delta.direction === 'up' ? 'M5 1.5 9 7.5H1z' : 'M5 8.5 1 2.5h8z'} />
          </svg>
          <span className="sr-only">{delta.direction === 'up' ? '升' : '降'}</span>
        </>
      )}
      {delta.text}
    </span>
  )
}

/** 图例一项：记号加名字，可再跟一个 ⓘ。 */
export function LegendItem({ marks, children }: { marks: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {marks}
      {children}
    </span>
  )
}

/** 图例记号：柱与分项是方块，当天的值是圆点，均线是横线（30 日均线虚线），非活跃日是描边浅灰块。 */
export function Mark({
  kind,
  color,
}: {
  kind: 'bar' | 'dot' | 'line' | 'average' | 'dash' | 'inactive' | 'swatch'
  color?: string
}) {
  switch (kind) {
    case 'bar':
      return <i aria-hidden className="size-2.5 shrink-0 rounded-xs bg-chart-1" />
    case 'dot':
      return (
        <i
          aria-hidden
          className="size-1.75 shrink-0 rounded-full bg-chart-ord-4"
          style={color === undefined ? undefined : { background: color }}
        />
      )
    case 'line':
      return <i aria-hidden className="h-0.5 w-4 shrink-0 rounded-full bg-chart-1" />
    case 'average':
      return <i aria-hidden className="h-0.5 w-4 shrink-0 rounded-full bg-primary" />
    case 'dash':
      return <i aria-hidden className="w-4 shrink-0 border-t-2 border-dashed border-chart-ghost" />
    case 'inactive':
      return (
        <i
          aria-hidden
          className="size-3 shrink-0 rounded-xs bg-chart-inactive ring-1 ring-hairline ring-inset"
        />
      )
    case 'swatch':
      return (
        <i aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: color }} />
      )
  }
}
