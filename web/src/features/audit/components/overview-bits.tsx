import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { Delta } from '../overview-model'

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

export function Section({
  id,
  title,
  info,
  aside,
  children,
}: {
  id: string
  title: string
  info: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex scroll-mt-4 flex-col gap-3" id={id}>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="flex items-center text-title font-semibold text-on-surface">
          <span id={`${id}-title`}>{title}</span>
          <InfoTip text={info} />
        </h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

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

export function LegendItem({ marks, children }: { marks: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {marks}
      {children}
    </span>
  )
}

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
