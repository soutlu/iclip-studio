import { useAuditOverview } from '../audit.api'
import { fmtMoment } from '../overview-format'
import type { OverviewRange } from '../overview-range'

export function OverviewAsOf({ range }: { range: OverviewRange }) {
  const { data } = useAuditOverview(range)
  if (data === undefined) return null
  return (
    <p className="text-label text-on-surface-muted">
      数据截至 {fmtMoment(new Date(data.window.generatedAt))}
    </p>
  )
}
