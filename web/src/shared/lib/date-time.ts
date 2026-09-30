import { recencyBucket } from './recency-group'

const pad = (value: number) => String(value).padStart(2, '0')

/** 使用本地时区绝对时刻，便于区分同日生成记录；无效输入返回空串。 */
export const formatDateTime = (iso: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 卡片下方那一行的短时刻，按与 now 相差的本地日历日：今天 `13:05`，昨天 `昨天 17:30`，更早 `9月27日`。
 * 比 now 还晚的算今天；无效输入返回空串。 */
export const formatShortTime = (iso: string, now: Date): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  switch (recencyBucket(iso, now)) {
    case 'today':
      return clock
    case 'yesterday':
      return `昨天 ${clock}`
    case 'week':
    case 'earlier':
      return `${at.getMonth() + 1}月${at.getDate()}日`
  }
}
