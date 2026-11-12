import { describe, expect, it } from 'vitest'
import {
  FIT_ZOOM,
  nextZoom,
  sliderToZoom,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  zoomLabel,
  zoomToBlocks,
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

describe('缩放到选中的块', () => {
  const FIT_PPS = 50
  // 能排时间的宽度 1000 像素，两边各留 24，这一段铺满 952 像素
  const WIDTH = 1_000

  it('选中的块合起来从 2 秒到 6 秒：每秒 238 像素，滚到起点左边 24 像素', () => {
    const target = zoomToBlocks(
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
    expect(zoomToBlocks([{ start: 0, duration: 3_000 }], WIDTH, FIT_PPS)).toEqual({
      zoom: { mode: 'manual', percent: 635 },
      scrollLeft: 0,
    })
    expect(zoomToBlocks([{ start: 0, duration: 1_000_000 }], WIDTH, FIT_PPS)?.zoom.percent).toBe(10)
    // 30 帧一秒、一帧 48 像素是每秒 1440 像素，是 50 的 2880%
    const tiny = zoomToBlocks([{ start: 1_000, duration: 10 }], WIDTH, FIT_PPS)
    expect(tiny).toEqual({ zoom: { mode: 'manual', percent: 2_880 }, scrollLeft: 1_440 - 24 })
  })

  it('没有选中的块、块没有长度、还没量出宽度时不缩放', () => {
    expect(zoomToBlocks([], WIDTH, FIT_PPS)).toBeNull()
    expect(zoomToBlocks([{ start: 1_000, duration: 0 }], WIDTH, FIT_PPS)).toBeNull()
    expect(zoomToBlocks([{ start: 1_000, duration: 500 }], 0, FIT_PPS)).toBeNull()
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
