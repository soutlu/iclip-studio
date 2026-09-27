/** 页头标题旁的「数据截至」：读总览同一份缓存里的生成时刻，数据没到就不显示。 */

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
