import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fmtMoment, periodLabel, tickLabel } from './overview-format'

// 浏览器在纽约：日期、时刻与星期仍按 UTC+8 写。
beforeAll(() => vi.stubEnv('TZ', 'America/New_York'))
afterAll(() => vi.unstubAllEnvs())

/** UTC 16:30 是 UTC+8 次日 00:30（9 月 15 日，周二），纽约还是 14 日中午。 */
const AFTER_MIDNIGHT = new Date('2026-09-14T16:30:00Z')
/** 9 月 15 日 UTC+8 零点。 */
const DAY_START = new Date('2026-09-14T16:00:00Z')

describe('按 UTC+8 写日期', () => {
  it('跨过 UTC+8 零点的时刻落在次日', () => {
    expect(fmtMoment(AFTER_MIDNIGHT)).toBe('9月15日 00:30')
  })

  it('按天的一期带 UTC+8 的星期，按小时写 UTC+8 的整点', () => {
    const window = { since: DAY_START, until: new Date('2026-09-21T16:00:00Z') }
    expect(periodLabel(DAY_START, 'day', window)).toBe('9月15日 周二')
    expect(periodLabel(new Date('2026-09-14T17:00:00Z'), 'hour', window)).toBe('9月15日 01:00')
  })

  it('按小时的刻度在 UTC+8 零点写日期，其余写几时', () => {
    expect(tickLabel(DAY_START, 'hour', false)).toBe('9/15')
    expect(tickLabel(new Date('2026-09-14T17:00:00Z'), 'hour', false)).toBe('1时')
  })
})
