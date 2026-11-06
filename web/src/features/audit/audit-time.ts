export const AUDIT_TIME_ZONE = 'Asia/Singapore'

const OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

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

const zonedMidnight = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day) - OFFSET_MS)

export const startOfZonedDay = (at: Date): Date => {
  const { year, month, day } = zonedParts(at)
  return zonedMidnight(year, month, day)
}

export const startOfZonedMonth = (at: Date, months = 0): Date => {
  const { year, month } = zonedParts(at)
  return zonedMidnight(year, month + months, 1)
}

export const addDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS)

export const formatZonedDate = (at: Date): string => {
  const { year, month, day } = zonedParts(at)
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-')
}

export const parseZonedDate = (text: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const at = zonedMidnight(Number(match[1]), Number(match[2]), Number(match[3]))
  return formatZonedDate(at) === text ? at : null
}

export const toCalendarDay = (at: Date): Date => {
  const { year, month, day } = zonedParts(at)
  return new Date(year, month - 1, day)
}

export const fromCalendarDay = (day: Date): Date =>
  zonedMidnight(day.getFullYear(), day.getMonth() + 1, day.getDate())
