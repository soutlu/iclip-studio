import { describe, expect, it } from 'vitest'
import { DEFAULT_SPLIT, resizeSplit, resolveSplitLeft } from './split-layout'

describe('resolveSplitLeft', () => {
  it('默认占比：普通 1:1，长文本面板 2:3', () => {
    expect(resolveSplitLeft(DEFAULT_SPLIT.normal, 1200, 'normal')).toBe(600)
    expect(resolveSplitLeft(DEFAULT_SPLIT.wide, 1200, 'wide')).toBe(480)
  })

  it('左右两栏都不小于各自最小宽', () => {
    expect(resolveSplitLeft(0.1, 1200, 'normal')).toBe(360)
    expect(resolveSplitLeft(0.9, 1200, 'normal')).toBe(800)
    expect(resolveSplitLeft(0.1, 1200, 'wide')).toBe(420)
    expect(resolveSplitLeft(0.9, 1200, 'wide')).toBe(800)
  })

  it('容器放不下两栏最小宽时左栏保底', () => {
    expect(resolveSplitLeft(DEFAULT_SPLIT.wide, 600, 'wide')).toBe(420)
    expect(resolveSplitLeft(DEFAULT_SPLIT.normal, 700, 'normal')).toBe(360)
  })

  it('窗口变化只影响换算结果，回到原宽度后还是原来的左栏宽', () => {
    const share = 0.7
    expect(resolveSplitLeft(share, 1000, 'normal')).toBe(600)
    expect(resolveSplitLeft(share, 1200, 'normal')).toBe(800)
    expect(resolveSplitLeft(share, 2000, 'normal')).toBe(1400)
  })
})

describe('resizeSplit', () => {
  it('只改当前布局的占比，并夹在最小宽之内', () => {
    expect(resizeSplit(DEFAULT_SPLIT, 'normal', 480, 1200)).toEqual({
      normal: 0.4,
      wide: DEFAULT_SPLIT.wide,
    })
    const resized = resizeSplit(DEFAULT_SPLIT, 'normal', 100, 1200)
    expect(resized).toEqual({ normal: 0.3, wide: DEFAULT_SPLIT.wide })
    expect(resizeSplit(resized, 'wide', 1100, 1200)).toEqual({ normal: 0.3, wide: 800 / 1200 })
  })

  it('容器放不下两栏最小宽时拖动不改占比', () => {
    expect(resizeSplit(DEFAULT_SPLIT, 'wide', 300, 800)).toBe(DEFAULT_SPLIT)
  })
})
