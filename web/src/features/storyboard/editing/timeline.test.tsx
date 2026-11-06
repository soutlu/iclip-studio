import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { finishFrameLoads } from '@/testing/timeline-frames'
import { Frames } from './timeline'

// 加载成功的图按地址记在模块里，各用例用自己的素材，互不串。
const mediaOf = (name: string) => `https://bucket.oss-cn-hangzhou.aliyuncs.com/${name}.mp4`

/** 每张图取的是素材的第几毫秒。 */
const timesOf = (images: readonly HTMLImageElement[]) =>
  images.map((image) => Number(/t_(\d+),/.exec(image.getAttribute('src') ?? '')?.[1]))

const framesOf = (mediaUrl: string, start: number, end: number) => (
  <Frames part={{ mediaUrl, start, end }} />
)

const imagesIn = (container: HTMLElement) => [...container.querySelectorAll('img')]

afterEach(() => vi.unstubAllGlobals())

describe('Frames', () => {
  it('按素材时间的固定格子取帧：起点往里裁一点，重叠的格子还是原来那张图，不重新取', async () => {
    const viewport = stubIntersectionObserver()
    const media = mediaOf('grid')
    const view = render(framesOf(media, 1.2, 4))
    await viewport.scroll(true)
    finishFrameLoads(view.container)
    const before = imagesIn(view.container)
    // 0.5 秒一格，取格子中点：碰到 1.0–4.0 秒的六格
    expect(timesOf(before)).toEqual([1250, 1750, 2250, 2750, 3250, 3750])

    view.rerender(framesOf(media, 1.6, 4))
    const after = imagesIn(view.container)
    expect(timesOf(after)).toEqual([1750, 2250, 2750, 3250, 3750])
    after.forEach((image, at) => expect(image).toBe(before[at + 1]))
  })

  it('格子太多时格宽翻倍，一段最多 24 格', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('long'), 0.3, 30.3))
    await viewport.scroll(true)
    finishFrameLoads(view.container)
    const times = timesOf(imagesIn(view.container))
    expect(times.length).toBeLessThanOrEqual(24)
    // 2 秒一格：中点都在奇数秒
    expect(times.every((time) => time % 2000 === 1000)).toBe(true)
    expect(times.at(0)).toBe(1000)
    expect(times.at(-1)).toBe(31_000)
  })
})

describe('Frames 限量排队', () => {
  it('全部进入可视区时只请求 3 张，一张加载完才出下一张', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('limit'), 1, 4))
    await viewport.scroll(true)
    expect(timesOf(imagesIn(view.container))).toEqual([1250, 1750, 2250])

    const [first] = imagesIn(view.container)
    if (first === undefined) throw new Error('没有图')
    fireEvent.load(first)
    expect(timesOf(imagesIn(view.container))).toEqual([1250, 1750, 2250, 2750])
  })

  it('加载失败的格子留空，也让出名额', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('failed'), 1, 4))
    await viewport.scroll(true)
    const [first] = imagesIn(view.container)
    if (first === undefined) throw new Error('没有图')
    fireEvent.error(first)
    expect(timesOf(imagesIn(view.container))).toEqual([1750, 2250, 2750])
  })

  it('不在可视区的不请求', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('outside'), 1, 4))
    await viewport.scroll(false)
    expect(imagesIn(view.container)).toEqual([])
  })

  it('还在排队就离开可视区的不再请求，已开始的继续', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('left'), 1, 4))
    await viewport.scroll(true)
    await viewport.scroll(false)
    const running = imagesIn(view.container)
    expect(running).toHaveLength(3)
    for (const image of running) fireEvent.load(image)
    expect(imagesIn(view.container)).toHaveLength(3)
  })

  it('卸载时释放名额：加载到一半关掉，后面的还能开始', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('closed'), 1, 4))
    await viewport.scroll(true)
    view.unmount()
    const next = render(framesOf(mediaOf('after-closed'), 1, 4))
    await viewport.scroll(true)
    expect(imagesIn(next.container)).toHaveLength(3)
  })

  it('加载过的图再次挂载直接显示，不等可视区也不排队', async () => {
    const viewport = stubIntersectionObserver()
    const media = mediaOf('seen')
    const view = render(framesOf(media, 1, 4))
    await viewport.scroll(true)
    finishFrameLoads(view.container)
    view.unmount()

    await viewport.scroll(false)
    const again = render(framesOf(media, 1, 4))
    expect(imagesIn(again.container)).toHaveLength(6)
  })
})
