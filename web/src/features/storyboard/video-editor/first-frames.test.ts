import { describe, expect, it } from 'vitest'
import { planFrames, type Size } from './first-frames'

const PORTRAIT_3_4 = { width: 834, height: 1112 }

const plan = (
  images: Record<string, Size | undefined>,
  video: Size | null = PORTRAIT_3_4,
  crops = new Map(),
) =>
  planFrames({
    urls: Object.keys(images),
    sizeOf: (url) => images[url],
    video: video ?? undefined,
    crops,
  })

describe('图生每张图的用途', () => {
  it.each([
    [['a'], ['首帧']],
    [
      ['a', 'b'],
      ['首帧', '尾帧'],
    ],
    [
      ['a', 'b', 'c'],
      ['参考图', '参考图', '参考图'],
    ],
  ])('%j 依次是 %j', (urls, roles) => {
    const plans = plan(Object.fromEntries(urls.map((url) => [url, PORTRAIT_3_4])))
    expect([...plans.values()].map((item) => item.role)).toEqual(roles)
  })

  it('参考图与原片画幅不同也不裁', () => {
    const plans = plan({ a: { width: 2560, height: 1440 }, b: PORTRAIT_3_4, c: PORTRAIT_3_4 })
    expect(plans.get('a')).toEqual({
      role: '参考图',
      crop: undefined,
      details: '参考图 · 2560 × 1440',
    })
  })
})

describe('首帧、尾帧的裁切', () => {
  it('与原片画幅相差 1% 以内不裁，说明里写原图尺寸', () => {
    expect(plan({ a: { width: 840, height: 1112 } }).get('a')).toEqual({
      role: '首帧',
      crop: undefined,
      details: '首帧 · 840 × 1112',
    })
  })

  it('横图裁成竖的原片画幅：默认取整高、居中的最大框', () => {
    expect(plan({ a: { width: 2560, height: 1440 } }).get('a')).toEqual({
      role: '首帧',
      crop: {
        value: { unit: '%', x: 28.90625, y: 0, width: 42.1875, height: 100 },
        rect: { x: 740, y: 0, width: 1080, height: 1440 },
      },
      details: '首帧 · 已裁成 3:4',
    })
  })

  it('竖图裁成横的原片画幅：取整宽、居中，像素框不越出原图', () => {
    const crop = plan({ a: { width: 1000, height: 2000 } }, { width: 1920, height: 1080 }).get(
      'a',
    )?.crop
    expect(crop?.value).toMatchObject({ x: 0, width: 100, height: 28.125, y: 35.9375 })
    expect(crop?.rect).toEqual({ x: 0, y: 719, width: 1000, height: 563 })
  })

  it('用户拖过的框照用；裁出来比原片小时说明图片偏小', () => {
    const moved = { unit: '%' as const, x: 0, y: 0, width: 37.5, height: 100 }
    const plans = plan(
      { a: PORTRAIT_3_4, b: { width: 1000, height: 500 } },
      PORTRAIT_3_4,
      new Map([['b', moved]]),
    )
    expect(plans.get('b')).toEqual({
      role: '尾帧',
      crop: { value: moved, rect: { x: 0, y: 0, width: 375, height: 500 } },
      details: '尾帧 · 已裁成 3:4 · 图片偏小',
    })
  })

  it('原片画幅不是常见比例时写像素尺寸', () => {
    expect(
      plan({ a: { width: 4000, height: 2000 } }, { width: 1000, height: 1300 }).get('a'),
    ).toMatchObject({ details: '首帧 · 已裁成 1000 × 1300' })
  })

  it('原图或原片尺寸还没读到时不裁', () => {
    expect(plan({ a: undefined }).get('a')).toEqual({
      role: '首帧',
      crop: undefined,
      details: '首帧',
    })
    expect(plan({ a: { width: 2560, height: 1440 } }, null).get('a')).toEqual({
      role: '首帧',
      crop: undefined,
      details: '首帧 · 2560 × 1440',
    })
  })
})
