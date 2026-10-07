import { describe, expect, it } from 'vitest'
import { snapToKeyframes } from './reference-clip'

describe('snapToKeyframes', () => {
  // 24fps 的模型出片，关键帧落在镜头切点上，间隔不等。
  const keyframes = [0, 1.916667, 4.208333, 6.5]
  const duration = 8.042

  it.each([
    [
      '两端正好在关键帧上，不动',
      { start: 1.916667, end: 4.208333 },
      { start: 1.916667, end: 4.208333 },
    ],
    [
      '两端在两个关键帧之间：起点往前退，终点往后进',
      { start: 2.5, end: 3 },
      { start: 1.916667, end: 4.208333 },
    ],
    ['起点为 0', { start: 0, end: 1 }, { start: 0, end: 1.916667 }],
    ['终点越过最后一个关键帧就到片尾', { start: 5, end: 7 }, { start: 4.208333, end: 8.042 }],
    ['跨过几个关键帧只取外侧那两个', { start: 1, end: 5 }, { start: 0, end: 6.5 }],
  ])('%s', (_name, range, snapped) => {
    expect(snapToKeyframes(keyframes, duration, range)).toEqual(snapped)
  })

  it('选段与关键帧只差浮点误差，算正好落在关键帧上，不多切出一段', () => {
    expect(snapToKeyframes([0, 1.0000004, 2], 3, { start: 1, end: 1.9999996 })).toEqual({
      start: 1.0000004,
      end: 2,
    })
  })

  it('关键帧表乱序也按时刻找', () => {
    expect(snapToKeyframes([4, 0, 2], 6, { start: 2.5, end: 3.5 })).toEqual({ start: 2, end: 4 })
  })

  it('首个关键帧晚于起点时从 0 起', () => {
    expect(snapToKeyframes([0.04, 2], 4, { start: 0, end: 1 })).toEqual({ start: 0, end: 2 })
  })
})
