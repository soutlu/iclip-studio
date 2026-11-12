import { describe, expect, it } from 'vitest'
import { picture } from '@/testing/whole-film'
import type { PictureBlock } from './composition/film'
import { landingOn, opensOwnRow, rowOpening, rowsOf } from './placement'

const first = picture({ id: 'a', start: 0, duration: 2_000 })
const later = picture({ id: 'b', start: 5_000, duration: 1_000 })
const below = picture({ id: 'c', start: 1_000, duration: 1_000, track: 1 })
const blocks = [first, later, below]

describe('时间线上的摆放', () => {
  it('按行分块：行号小的在前，行里按开始时间排', () => {
    const rows = rowsOf([later, below, first])
    expect(rows.map((row) => [row.track, row.blocks.map((block) => block.id)])).toEqual([
      [0, ['a', 'b']],
      [1, ['c']],
    ])
  })

  it('指针在空处：就放在指针的位置', () => {
    expect(landingOn(blocks, 0, 2_500, 1_000)).toEqual({ track: 0, start: 2_500 })
  })

  it('指针压在别的块上：挪到最近的空位', () => {
    expect(landingOn(blocks, 0, 1_800, 1_000)).toEqual({ track: 0, start: 2_000 })
    expect(landingOn(blocks, 0, 4_600, 1_000)).toEqual({ track: 0, start: 4_000 })
  })

  it('空位不够长：接在这一行最后一个块后面', () => {
    expect(landingOn(blocks, 0, 2_500, 4_000)).toEqual({ track: 0, start: 6_000 })
  })

  it('别的行上的块不挡路', () => {
    expect(landingOn(blocks, 1, 0, 1_000)).toEqual({ track: 1, start: 0 })
  })
})

describe('新开一行', () => {
  const opened = (pictures: PictureBlock[], insertAt: number, movedId?: string) => {
    const { track, renumber } = rowOpening(pictures, insertAt, movedId)
    return { track, renumber: [...renumber] }
  }

  it('开在最上面：新的一行是 0 号，别的行都往后排一号', () => {
    expect(opened(blocks, 0)).toEqual({
      track: 0,
      renumber: [
        ['a', 1],
        ['b', 1],
        ['c', 2],
      ],
    })
  })

  it('开在两行之间：上面的行不动，下面的行往后排一号', () => {
    expect(opened(blocks, 1)).toEqual({ track: 1, renumber: [['c', 2]] })
  })

  it('开在最下面：别的行都不动', () => {
    expect(opened(blocks, 2)).toEqual({ track: 2, renumber: [] })
  })

  it('行号原来有空着的：顺带从 0 起连着排', () => {
    const gapped = [
      picture({ id: 'a', track: 2 }),
      picture({ id: 'b', track: 5 }),
      picture({ id: 'c', track: 9 }),
    ]
    expect(opened(gapped, 2)).toEqual({
      track: 2,
      renumber: [
        ['a', 0],
        ['b', 1],
        ['c', 3],
      ],
    })
  })

  it('搬进新行的块原来那一行只剩它：那一行不再算，位置按剩下的行数', () => {
    // c 自己占着第 2 行，搬到最上面：a、b 那一行排到 1 号，c 原来那一行空出来
    expect(opened(blocks, 0, 'c')).toEqual({
      track: 0,
      renumber: [
        ['a', 1],
        ['b', 1],
      ],
    })
    // 搬到自己这一行的上面或下面那道缝：还是原来的号，别的块也不用动
    expect(opened(blocks, 1, 'c')).toEqual({ track: 1, renumber: [] })
    expect(opened(blocks, 2, 'c')).toEqual({ track: 1, renumber: [] })
  })

  it('搬进新行的块原来那一行还有别的块：那一行照常算', () => {
    expect(opened(blocks, 1, 'b')).toEqual({ track: 1, renumber: [['c', 2]] })
  })

  it('独占一行的块在自己这一行的上面或下面新开一行：等于没换行；行号有空着的也按时间线上的位置算', () => {
    expect([0, 1, 2].map((insertAt) => opensOwnRow(blocks, insertAt, 'c'))).toEqual([
      false,
      true,
      true,
    ])
    // a 那一行还有 b：在它上面、下面新开一行都是真的换行
    expect([0, 1].map((insertAt) => opensOwnRow(blocks, insertAt, 'a'))).toEqual([false, false])
    const gapped = [picture({ id: 'a', track: 2 }), picture({ id: 'c', track: 7 })]
    expect([0, 1, 2].map((insertAt) => opensOwnRow(gapped, insertAt, 'c'))).toEqual([
      false,
      true,
      true,
    ])
  })
})
