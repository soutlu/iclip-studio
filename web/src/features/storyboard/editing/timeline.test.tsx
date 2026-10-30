import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Frames } from './timeline'

const MEDIA = 'https://bucket.oss-cn-hangzhou.aliyuncs.com/clip.mp4'

/** 每张图取的是素材的第几毫秒。 */
const timesOf = (images: readonly HTMLImageElement[]) =>
  images.map((image) => Number(/t_(\d+),/.exec(image.getAttribute('src') ?? '')?.[1]))

const framesOf = (start: number, end: number) => <Frames part={{ mediaUrl: MEDIA, start, end }} />

describe('Frames', () => {
  it('按素材时间的固定格子取帧：起点往里裁一点，重叠的格子还是原来那张图，不重新取', () => {
    const view = render(framesOf(1.2, 4))
    const before = [...view.container.querySelectorAll('img')]
    // 0.5 秒一格，取格子中点：碰到 1.0–4.0 秒的六格
    expect(timesOf(before)).toEqual([1250, 1750, 2250, 2750, 3250, 3750])

    view.rerender(framesOf(1.6, 4))
    const after = [...view.container.querySelectorAll('img')]
    expect(timesOf(after)).toEqual([1750, 2250, 2750, 3250, 3750])
    after.forEach((image, at) => expect(image).toBe(before[at + 1]))
  })

  it('格子太多时格宽翻倍，一段最多 24 格', () => {
    const view = render(framesOf(0.3, 30.3))
    const times = timesOf([...view.container.querySelectorAll('img')])
    expect(times.length).toBeLessThanOrEqual(24)
    // 2 秒一格：中点都在奇数秒
    expect(times.every((time) => time % 2000 === 1000)).toBe(true)
    expect(times.at(0)).toBe(1000)
    expect(times.at(-1)).toBe(31_000)
  })
})
