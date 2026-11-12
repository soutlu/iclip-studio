import { describe, expect, it } from 'vitest'
import {
  FIT_ZOOM,
  nextZoom,
  sliderToZoom,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  zoomLabel,
  zoomToSlider,
} from './timeline-scale'

// 一秒 100 像素：吸附的范围是 8 像素，也就是 80 毫秒
const PPS = 100
const targets = snapTargets(
  [
    { id: 'a', start: 0, duration: 2_000 },
    { id: 'b', start: 5_000, duration: 1_000 },
  ],
  3_300,
)

describe('时间线缩放', () => {
  // 适应宽度时一秒 50 像素
  const FIT_PPS = 50

  it('适应宽度时读数写「适应」，手动缩放后写相对适应宽度的百分比', () => {
    expect(zoomLabel(FIT_ZOOM, FIT_PPS)).toBe('适应')
    expect(zoomLabel(nextZoom('in', FIT_ZOOM, FIT_PPS), FIT_PPS)).toBe('200%')
    expect(zoomLabel(nextZoom('out', FIT_ZOOM, FIT_PPS), FIT_PPS)).toBe('50%')
  })

  it('滑杆和缩放来回换算对得上；最左是最小，最右是放到最大', () => {
    for (const percent of [10, 50, 100, 400]) {
      const slider = zoomToSlider({ mode: 'manual', percent }, FIT_PPS)
      expect(sliderToZoom(slider, FIT_PPS)).toEqual({ mode: 'manual', percent })
    }
    expect(sliderToZoom(0, FIT_PPS).percent).toBe(10)
    expect(sliderToZoom(100, FIT_PPS).percent).toBeGreaterThan(1_000)
    expect(zoomToSlider(FIT_ZOOM, FIT_PPS)).toBeGreaterThan(0)
    expect(zoomToSlider(FIT_ZOOM, FIT_PPS)).toBeLessThan(100)
  })
})

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
