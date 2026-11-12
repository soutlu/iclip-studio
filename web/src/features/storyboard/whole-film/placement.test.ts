import { describe, expect, it } from 'vitest'
import { picture } from '@/testing/whole-film'
import { landingOn, rowsOf } from './placement'

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
