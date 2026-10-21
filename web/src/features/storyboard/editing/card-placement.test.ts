import { describe, expect, it } from 'vitest'
import { placeCard } from './card-placement'

describe('placeCard', () => {
  it.each([
    {
      name: '选区在中间：卡居中对准，尖角在卡正中',
      anchorX: 600,
      expected: { left: 320, notch: 280 },
    },
    {
      name: '选区靠左：卡夹在左边留 12px，尖角挪到选区上',
      anchorX: 100,
      expected: { left: 12, notch: 88 },
    },
    { name: '选区贴着左边：尖角不戳到圆角上', anchorX: 4, expected: { left: 12, notch: 28 } },
    { name: '选区靠右：卡夹在右边留 12px', anchorX: 1150, expected: { left: 628, notch: 522 } },
    {
      name: '选区贴着右边：尖角停在离右边 28px 处',
      anchorX: 1199,
      expected: { left: 628, notch: 532 },
    },
  ])('$name', ({ anchorX, expected }) => {
    expect(placeCard(1200, anchorX, 560)).toEqual(expected)
  })

  it('舞台比卡窄（窄屏卡宽是舞台宽减两边留白）：卡贴左边 12px，尖角仍对准选区', () => {
    expect(placeCard(366, 200, 342)).toEqual({ left: 12, notch: 188 })
  })
})
