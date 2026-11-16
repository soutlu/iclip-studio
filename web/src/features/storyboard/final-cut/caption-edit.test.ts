import { describe, expect, it } from 'vitest'
import { captionClock, captionSpot, captionsInOrder } from './caption-edit'

const caption = (id: string, start: number, duration: number) => ({ id, start, duration })

describe('在播放头处加一句字幕', () => {
  it('没有字幕时从播放头起放 2 秒', () => {
    expect(captionSpot([], 1500)).toEqual({ start: 1500, duration: 2000 })
  })

  it('后面的字幕离得远时照样 2 秒，前面的字幕不碍事', () => {
    expect(captionSpot([caption('a', 0, 1000), caption('b', 5000, 1000)], 1000)).toEqual({
      start: 1000,
      duration: 2000,
    })
  })

  it('碰到后面的字幕时缩短到碰到为止', () => {
    expect(captionSpot([caption('b', 2200, 1000)], 1000)).toEqual({ start: 1000, duration: 1200 })
  })

  it('播放头处已有字幕时不能加，正好在一句的结尾处可以加', () => {
    expect(captionSpot([caption('a', 1000, 2000)], 1000)).toEqual({ refusal: 'taken' })
    expect(captionSpot([caption('a', 1000, 2000)], 2999)).toEqual({ refusal: 'taken' })
    expect(captionSpot([caption('a', 1000, 2000)], 3000)).toEqual({ start: 3000, duration: 2000 })
  })

  it('离下一句不到 0.1 秒时不能加，正好 0.1 秒可以', () => {
    expect(captionSpot([caption('b', 1050, 1000)], 1000)).toEqual({ refusal: 'tight' })
    expect(captionSpot([caption('b', 1100, 1000)], 1000)).toEqual({ start: 1000, duration: 100 })
  })
})

describe('字幕列表里的时间', () => {
  it('分:秒，秒带两位小数', () => {
    expect([0, 1500, 61_005, 600_000].map(captionClock)).toEqual([
      '00:00.00',
      '00:01.50',
      '01:01.01',
      '10:00.00',
    ])
  })
})

describe('字幕的先后', () => {
  it('按开始时间排，一样时按编号', () => {
    const ordered = captionsInOrder([caption('c', 3000, 1), caption('b', 0, 1), caption('a', 0, 1)])
    expect(ordered.map((each) => each.id)).toEqual(['a', 'b', 'c'])
  })
})
