import { describe, expect, it } from 'vitest'
import { canvasForVideo, canvasLabel } from './canvas-size'

describe('canvasLabel', () => {
  it.each([
    [1080, 1920, '9:16'],
    [2520, 1080, '21:9'],
    [720, 1280, '9:16'],
    [1280, 800, '8:5'],
    [1080, 1350, '4:5'],
    [1080, 1514, '1080×1514'],
  ])('%i×%i 写成 %s', (width, height, label) => {
    expect(canvasLabel({ width, height })).toBe(label)
  })
})

describe('canvasForVideo', () => {
  it.each([
    [480, 854, 1080, 1920],
    [720, 1280, 1080, 1920],
    [1280, 720, 1920, 1080],
    [854, 480, 1920, 1080],
    [600, 800, 1080, 1440],
    [1440, 1080, 1440, 1080],
    [1080, 1080, 1080, 1080],
    [2560, 1080, 2560, 1080],
    [2520, 1080, 2520, 1080],
    [500, 701, 1080, 1514],
  ])(
    '%i×%i 的视频 → %i×%i：比例跟视频，短边 1080，宽高取偶数，差取整误差时用预设',
    (width, height, canvasWidth, canvasHeight) => {
      expect(canvasForVideo({ width, height })).toEqual({
        width: canvasWidth,
        height: canvasHeight,
      })
    },
  )
})
