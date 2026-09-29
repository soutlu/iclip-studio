/**
 * 审计页的时间口径：统计与显示一律按 UTC+8，不随浏览器时区；只读入参的 getTime()，按固定偏移换算。
 * 唯一的例外是末尾两个日历适配函数：日历组件按浏览器本地日历出格子，只有它们读写本地年月日。
 */

/** 发给后端切日、切小时、切周的时区；它自 1982 年起固定 UTC+8、没有夏令时，与下面的固定偏移一致。 */
export const AUDIT_TIME_ZONE = 'Asia/Singapore'

const OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/** 一个时刻在 UTC+8 的日历字段：month 从 1 起，weekday 0 为周日。 */
export type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

export const zonedParts = (at: Date): ZonedParts => {
  const shifted = new Date(at.getTime() + OFFSET_MS)
  return {
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    month: shifted.getUTCMonth() + 1,
    weekday: shifted.getUTCDay(),
    year: shifted.getUTCFullYear(),
  }
}

/** UTC+8 某日零点的时刻；month 从 1 起，月与日越界按日历进位。 */
const zonedMidnight = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day) - OFFSET_MS)

/** 所在那天的 UTC+8 零点。 */
export const startOfZonedDay = (at: Date): Date => {
  const { year, month, day } = zonedParts(at)
  return zonedMidnight(year, month, day)
}

/** 所在月往后挪 months 个月（可为负）的 1 日 UTC+8 零点。 */
export const startOfZonedMonth = (at: Date, months = 0): Date => {
  const { year, month } = zonedParts(at)
  return zonedMidnight(year, month + months, 1)
}

/** 往后挪整天（可为负）；UTC+8 没有夏令时，一天恒为 24 小时。 */
export const addDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS)

/** 所在那天的 UTC+8 日期，写成 YYYY-MM-DD。 */
export const formatZonedDate = (at: Date): string => {
  const { year, month, day } = zonedParts(at)
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-')
}

/** YYYY-MM-DD 解析成那天的 UTC+8 零点；格式不对或不是真实日期（如 2 月 30 日）返回 null。 */
export const parseZonedDate = (text: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const at = zonedMidnight(Number(match[1]), Number(match[2]), Number(match[3]))
  // 进位过的日期（2 月 30 日）与 Date.UTC 当成 19xx 年的 0000–0099 年写回来都对不上原文。
  return formatZonedDate(at) === text ? at : null
}

/**
 * 交给日历组件的一天：与该时刻 UTC+8 日期同年月日的本地零点。
 * 它只承载年月日，不当时刻用；日历给回来的日子要先经 fromCalendarDay 换回。
 */
export const toCalendarDay = (at: Date): Date => {
  const { year, month, day } = zonedParts(at)
  return new Date(year, month - 1, day)
}

/** 日历组件给回的本地日期（格子、翻到的月份）换回那天的 UTC+8 零点。 */
export const fromCalendarDay = (day: Date): Date =>
  zonedMidnight(day.getFullYear(), day.getMonth() + 1, day.getDate())
