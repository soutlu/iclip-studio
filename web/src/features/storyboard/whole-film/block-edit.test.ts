import { describe, expect, it } from 'vitest'
import { picture } from '@/testing/whole-film'
import { movedStart, rippleStarts, trimBounds, trimmed } from './block-edit'
import { MAX_FILM_MS } from './composition/film'

const first = picture({ id: 'a', start: 0, duration: 2_000 })
const middle = picture({ id: 'b', start: 3_000, duration: 2_000, mediaStart: 1_500 })
const last = picture({ id: 'c', start: 6_000, duration: 1_000 })
const above = picture({ id: 'd', start: 2_000, duration: 5_000, track: 1 })
const film = [first, middle, last, above]

describe('裁剪一个块', () => {
  it('开头：往前不压到前一个块，也不早于素材的开头；往后至少留最短的长度', () => {
    expect(trimBounds(middle, 'start', film, 6_000)).toEqual({ min: 2_000, max: 4_900 })
    const tight = { ...middle, mediaStart: 400 }
    expect(trimBounds(tight, 'start', film, 6_000).min).toBe(2_600)
  })

  it('结尾：往后不压到后一个块，也不超出素材的结尾；别的行不挡路', () => {
    expect(trimBounds(middle, 'end', film, 10_000)).toEqual({ min: 3_100, max: 6_000 })
    expect(trimBounds(middle, 'end', film, 4_000).max).toBe(5_500)
    expect(trimBounds(last, 'end', film, 200_000).max).toBe(MAX_FILM_MS)
  })

  it('素材总长还不知道：结尾只能往里收', () => {
    expect(trimBounds(middle, 'end', film, undefined).max).toBe(5_000)
  })

  it('裁开头：起点和入点一起往后，结尾不动', () => {
    const bounds = trimBounds(middle, 'start', film, 6_000)
    expect(trimmed(middle, 'start', 3_400, bounds)).toEqual({
      start: 3_400,
      duration: 1_600,
      mediaStart: 1_900,
    })
    expect(trimmed(middle, 'start', 0, bounds)).toEqual({
      start: 2_000,
      duration: 3_000,
      mediaStart: 500,
    })
  })

  it('裁结尾：只改长度', () => {
    const bounds = trimBounds(middle, 'end', film, 10_000)
    expect(trimmed(middle, 'end', 9_000, bounds)).toEqual({
      start: 3_000,
      duration: 3_000,
      mediaStart: 1_500,
    })
  })
})

describe('在一行里挪一个块', () => {
  it('挪到空处就在那里；压到别的块时落到最近的空位；自己原来的位置不算占用', () => {
    expect(movedStart(middle, film, 2_200)).toBe(2_200)
    expect(movedStart(middle, film, 5_200)).toBe(4_000)
    expect(movedStart(middle, film, 3_500)).toBe(3_500)
  })

  it('不超出成片最长的长度', () => {
    expect(movedStart(last, film, MAX_FILM_MS)).toBe(MAX_FILM_MS - 1_000)
  })
})

describe('波纹编辑', () => {
  it('删掉第一行的块：它后面第一行的块往前补上它的长度，别的行不动', () => {
    expect([...rippleStarts(film, new Set(['a']))]).toEqual([
      ['b', 1_000],
      ['c', 4_000],
    ])
  })

  it('一次删几个：每个块挪的是它前面被删掉的总长', () => {
    expect([...rippleStarts(film, new Set(['a', 'b']))]).toEqual([['c', 2_000]])
  })

  it('删的不是第一行的块：谁都不动', () => {
    expect(rippleStarts(film, new Set(['d'])).size).toBe(0)
  })
})
