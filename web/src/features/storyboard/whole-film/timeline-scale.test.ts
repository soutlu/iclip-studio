import { describe, expect, it } from 'vitest'
import {
  FIT_ZOOM,
  rulerTickStep,
  snapMs,
  snapSpanStartMs,
  snapTargets,
  timelineScale,
} from './timeline-scale'

const spanSeconds = (totalMs: number) => {
  const scale = timelineScale(1_000, totalMs, FIT_ZOOM)
  return scale.contentWidth / scale.pps
}

describe('timelineScale', () => {
  it('适应宽度时刻度至少铺 20 秒：1 秒的成片只占 1/20', () => {
    expect(spanSeconds(1_000)).toBeCloseTo(20, 1)
    expect(spanSeconds(0)).toBeCloseTo(20, 1)
  })

  it('长片照 Studio 铺「时长 × 1.2」，片尾后留一截空轨', () => {
    expect(spanSeconds(60_000)).toBeCloseTo(72, 1)
  })
})

describe('rulerTickStep', () => {
  it('同刻度尺的标签间隔：约 8 格铺满时间区', () => {
    expect(rulerTickStep(20)).toBe(5)
    expect(rulerTickStep(3)).toBe(0.5)
    expect(rulerTickStep(72)).toBe(10)
    expect(rulerTickStep(1_000)).toBe(180)
  })
})

describe('吸附', () => {
  const targets = snapTargets({
    spans: [{ id: 'v1', start: 0, duration: 4_000 }],
    playheadMs: 6_000,
    beatsMs: [],
  })

  it('8 像素以内吸上并给出吸附线；关掉吸附原样返回', () => {
    expect(snapMs(4_050, targets, 100, true)).toEqual({ ms: 4_000, guideMs: 4_000 })
    expect(snapMs(4_200, targets, 100, true)).toEqual({ ms: 4_200, guideMs: null })
    expect(snapMs(4_050, targets, 100, false)).toEqual({ ms: 4_050, guideMs: null })
  })

  it('挪动的块：结尾离目标近时按结尾吸，长度不变', () => {
    expect(snapSpanStartMs(1_960, 2_000, targets, 100, true, 0)).toEqual({
      ms: 2_000,
      guideMs: 4_000,
    })
    expect(snapSpanStartMs(5_960, 1_000, targets, 100, true, 0)).toEqual({
      ms: 6_000,
      guideMs: 6_000,
    })
  })

  it('不夹到整片总长上限之内：放不放得下由编辑操作判断', () => {
    expect(snapSpanStartMs(115_000, 10_000, targets, 100, true, 5).ms).toBe(115_000)
  })

  it('两端附近都没有目标时才吸刻度', () => {
    expect(snapSpanStartMs(10_040, 1_000, targets, 100, true, 5)).toEqual({
      ms: 10_000,
      guideMs: 10_000,
    })
    expect(snapSpanStartMs(10_040, 1_000, targets, 100, true, 0)).toEqual({
      ms: 10_040,
      guideMs: null,
    })
  })
})
