import { describe, expect, it } from 'vitest'
import {
  FIT_ZOOM,
  nextZoom,
  sliderToZoom,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  timelineScale,
  zoomLabel,
  zoomScrollLeft,
  zoomToClips,
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

  it('一屏看得见多长的时间：适应宽度时是整条，放大四倍就只剩四分之一；还没量到宽度时按整条算', () => {
    const fit = timelineScale(1_000, 10_000, FIT_ZOOM)
    expect(fit.viewSeconds).toBeCloseTo(1_000 / fit.pps)
    const zoomed = timelineScale(1_000, 10_000, { mode: 'manual', percent: 400 })
    expect(zoomed.viewSeconds).toBeCloseTo(fit.viewSeconds / 4)
    const unmeasured = timelineScale(0, 10_000, FIT_ZOOM).viewSeconds
    expect(Number.isFinite(unmeasured) && unmeasured > 0).toBe(true)
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

  it('缩放时播放头留在屏幕上原来的地方；看不见它时把它放到时间区中间', () => {
    // 播放头在第 4 秒，一秒 50 像素、已经滚了 100 像素：它在屏幕上离时间区左边 100 像素
    expect(zoomScrollLeft(4_000, 100, 50, 100, 1_000)).toBe(300)
    expect(zoomScrollLeft(4_000, 300, 100, 50, 1_000)).toBe(100)
    // 缩小以后内容比原来滚到的位置还短：不会滚成负数
    expect(zoomScrollLeft(1_000, 0, 100, 25, 1_000)).toBe(0)
    // 播放头在第 30 秒，滚在最左边时它在屏幕右边外面（1500 像素处）：放到中间
    expect(zoomScrollLeft(30_000, 0, 50, 100, 1_000)).toBe(2_500)
    // 播放头在已经滚过去的左边：也放到中间
    expect(zoomScrollLeft(2_000, 1_000, 100, 200, 1_000)).toBe(0)
    expect(zoomScrollLeft(10_000, 1_500, 100, 200, 1_000)).toBe(1_500)
  })
})

describe('缩放到选中的片段', () => {
  const FIT_PPS = 50
  // 能排时间的宽度 1000 像素，两边各留 24，这一段铺满 952 像素
  const WIDTH = 1_000

  it('选中的片段合起来从 2 秒到 6 秒：每秒 238 像素，滚到起点左边 24 像素', () => {
    const target = zoomToClips(
      [
        { start: 3_000, duration: 3_000 },
        { start: 2_000, duration: 2_000 },
      ],
      WIDTH,
      FIT_PPS,
    )
    // 952 ÷ 4 秒 = 238 像素一秒，是适应宽度（50）的 476%
    expect(target).toEqual({ zoom: { mode: 'manual', percent: 476 }, scrollLeft: 2 * 238 - 24 })
    expect(zoomLabel(target?.zoom ?? FIT_ZOOM, FIT_PPS)).toBe('476%')
  })

  it('百分比取整，最小 10%、最大放到一帧 48 像素；从 0 秒开始的不往左滚', () => {
    expect(zoomToClips([{ start: 0, duration: 3_000 }], WIDTH, FIT_PPS)).toEqual({
      zoom: { mode: 'manual', percent: 635 },
      scrollLeft: 0,
    })
    expect(zoomToClips([{ start: 0, duration: 1_000_000 }], WIDTH, FIT_PPS)?.zoom.percent).toBe(10)
    // 30 帧一秒、一帧 48 像素是每秒 1440 像素，是 50 的 2880%
    const tiny = zoomToClips([{ start: 1_000, duration: 10 }], WIDTH, FIT_PPS)
    expect(tiny).toEqual({ zoom: { mode: 'manual', percent: 2_880 }, scrollLeft: 1_440 - 24 })
  })

  it('没有选中的片段、片段没有长度、还没量出宽度时不缩放', () => {
    expect(zoomToClips([], WIDTH, FIT_PPS)).toBeNull()
    expect(zoomToClips([{ start: 1_000, duration: 0 }], WIDTH, FIT_PPS)).toBeNull()
    expect(zoomToClips([{ start: 1_000, duration: 500 }], 0, FIT_PPS)).toBeNull()
  })
})

describe('时间线吸附', () => {
  it('一个时间点离别的片段的一端或播放头够近就吸上去，远了不吸', () => {
    expect(snapMs(2_050, targets, PPS)).toEqual({ ms: 2_000, guideMs: 2_000 })
    expect(snapMs(3_260, targets, PPS)).toEqual({ ms: 3_300, guideMs: 3_300 })
    expect(snapMs(2_200, targets, PPS)).toEqual({ ms: 2_200, guideMs: null })
  })

  it('挪一个片段：开头靠近就让开头吸上去，结尾靠近就让结尾吸上去', () => {
    expect(snapSpanStartMs(2_060, 1_000, targets, PPS)).toEqual({ ms: 2_000, guideMs: 2_000 })
    expect(snapSpanStartMs(3_950, 1_000, targets, PPS)).toEqual({ ms: 4_000, guideMs: 5_000 })
    expect(snapSpanStartMs(2_500, 300, targets, PPS)).toEqual({ ms: 2_500, guideMs: null })
  })

  it('放得越大，吸附的范围换成时间越小', () => {
    expect(snapMs(2_050, targets, 400).guideMs).toBeNull()
    expect(snapMs(2_015, targets, 400)).toEqual({ ms: 2_000, guideMs: 2_000 })
  })
})
