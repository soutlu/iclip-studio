import { expect, it } from 'vitest'
import { timeLabel } from './time-label'

it.each([
  [0, '00:00.00'],
  [59.999, '01:00.00'],
  [119.999, '02:00.00'],
])('时间预览将 %s 秒正确进位为 %s', (seconds, label) => {
  expect(timeLabel(seconds)).toBe(label)
})
