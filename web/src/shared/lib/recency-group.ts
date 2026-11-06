export type RecencyBucket = 'today' | 'yesterday' | 'week' | 'earlier'

export const RECENCY_LABEL: Record<RecencyBucket, string> = {
  earlier: '更早',
  today: '今天',
  week: '7 天内',
  yesterday: '昨天',
}

const DAY_MS = 24 * 60 * 60_000

const startOfLocalDay = (at: Date): number =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()

export const recencyBucket = (iso: string, now: Date): RecencyBucket => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'earlier'
  // 按四舍五入计算整日差，以兼容夏令时切换日的 23 或 25 小时。
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(at)) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'week'
  return 'earlier'
}

export const groupByRecency = <T>(
  items: readonly T[],
  dateOf: (item: T) => string,
  now: Date,
): { bucket: RecencyBucket; items: T[] }[] => {
  const groups: { bucket: RecencyBucket; items: T[] }[] = []
  for (const item of items) {
    const bucket = recencyBucket(dateOf(item), now)
    const last = groups.at(-1)
    if (last?.bucket === bucket) last.items.push(item)
    else groups.push({ bucket, items: [item] })
  }
  return groups
}
