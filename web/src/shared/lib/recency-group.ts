/** 按本地日历日把时刻归入「今天 / 昨天 / 7 天内 / 更早」，给按时间倒序的列表插分组标题。 */

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

/**
 * 与 now 相差的本地日历日数决定分组：0 天今天、1 天昨天、2–6 天 7 天内，其余更早。
 * 比 now 还晚的时刻（两端时钟有偏差）算今天；无效时刻算更早。
 */
export const recencyBucket = (iso: string, now: Date): RecencyBucket => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'earlier'
  // 夏令时切换日只有 23 或 25 小时，取整后仍是整日差。
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(at)) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'week'
  return 'earlier'
}

/** 按原顺序把相邻同组的条目切成一段，不重排；空组自然不出现。 */
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
