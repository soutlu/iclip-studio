/** 图表悬停提示的卡片：值在前、名在后，行首的小记号跟图上的记号同形同色。 */

import { cn } from '@/shared/lib/utils'
import type { TipRow } from '../overview-model'

export function ChartTooltipCard({ title, rows }: { title?: string; rows: readonly TipRow[] }) {
  return (
    <div className="max-w-75 min-w-40 rounded-md bg-inverse-surface px-3 py-2.5 text-label text-inverse-on-surface shadow-[var(--shadow-3)]">
      {title === undefined ? null : <p className="mb-1.5 text-inverse-on-surface/70">{title}</p>}
      {rows.map((row) => (
        <p
          className={cn(
            'mt-1 flex items-center gap-2 first:mt-0',
            row.total === true && 'mt-1.5 border-t border-inverse-on-surface/15 pt-1.5',
          )}
          key={`${row.mark ?? ''}${row.name}`}
        >
          <TipMark color={row.color} mark={row.mark} />
          <b className="text-body font-semibold tabular-nums">{row.value}</b>
          <span className="text-inverse-on-surface/70">{row.name}</span>
        </p>
      ))}
    </div>
  )
}

function TipMark({ mark, color }: { mark: TipRow['mark'] | undefined; color: string | undefined }) {
  if (mark === undefined || color === undefined) return null
  if (mark === 'box') {
    return <i aria-hidden className="h-2.5 w-3 shrink-0 rounded-xs" style={{ background: color }} />
  }
  if (mark === 'dot') {
    return (
      <i
        aria-hidden
        className="mx-0.5 size-2 shrink-0 rounded-full"
        style={{ background: color }}
      />
    )
  }
  return (
    <i
      aria-hidden
      className={cn('w-3 shrink-0 border-t-2', mark === 'dash' && 'border-dashed')}
      style={{ borderColor: color }}
    />
  )
}
