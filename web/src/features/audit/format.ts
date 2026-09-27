/** 把接口里的秒、token、比率翻成给人读的字；页面上不出现原始秒数与字段名。 */

export const EMPTY = '—'

export const formatCount = (value: number): string => value.toLocaleString('zh-CN')

/** 一万以上用「万」，一亿以上用「亿」；小数只在数字还小时保留一位。 */
export const formatTokens = (value: number): string => {
  if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 0 : 1)} 亿`
  if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)} 万`
  return formatCount(value)
}

export const formatRate = (ratio: number | null): string =>
  ratio === null ? EMPTY : `${(ratio * 100).toFixed(1)}%`

export const formatTimes = (value: number | null): string =>
  value === null ? EMPTY : `${value.toFixed(1)} 次`

/** 一分钟内说秒，一小时内说分，一天内说小时，再长说天。 */
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return EMPTY
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} 小时`
  return `${(seconds / 86_400).toFixed(1)} 天`
}
