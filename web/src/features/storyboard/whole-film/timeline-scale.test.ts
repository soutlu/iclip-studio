import { describe, expect, it } from 'vitest'
import { snapMs, snapSpanStartMs, snapTargets } from './timeline-scale'

// 一秒 100 像素：吸附的范围是 8 像素，也就是 80 毫秒
const PPS = 100
const targets = snapTargets(
  [
    { id: 'a', start: 0, duration: 2_000 },
    { id: 'b', start: 5_000, duration: 1_000 },
  ],
  3_300,
)

describe('时间线吸附', () => {
  it('一个时间点离别的块的一端或播放头够近就吸上去，远了不吸', () => {
    expect(snapMs(2_050, targets, PPS)).toEqual({ ms: 2_000, guideMs: 2_000 })
    expect(snapMs(3_260, targets, PPS)).toEqual({ ms: 3_300, guideMs: 3_300 })
    expect(snapMs(2_200, targets, PPS)).toEqual({ ms: 2_200, guideMs: null })
  })

  it('挪一个块：开头靠近就让开头吸上去，结尾靠近就让结尾吸上去', () => {
    expect(snapSpanStartMs(2_060, 1_000, targets, PPS)).toEqual({ ms: 2_000, guideMs: 2_000 })
    expect(snapSpanStartMs(3_950, 1_000, targets, PPS)).toEqual({ ms: 4_000, guideMs: 5_000 })
    expect(snapSpanStartMs(2_500, 300, targets, PPS)).toEqual({ ms: 2_500, guideMs: null })
  })

  it('放得越大，吸附的范围换成时间越小', () => {
    expect(snapMs(2_050, targets, 400).guideMs).toBeNull()
    expect(snapMs(2_015, targets, 400)).toEqual({ ms: 2_000, guideMs: 2_000 })
  })
})
