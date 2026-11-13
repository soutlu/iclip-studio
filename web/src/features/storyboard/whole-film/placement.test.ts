import { describe, expect, it } from 'vitest'
import { audio, component, picture } from '@/testing/whole-film'
import type { FilmBlock } from './composition/film'
import {
  landingOn,
  rowHidden,
  rowOpening,
  rowsOf,
  targetIn,
  topTrack,
  type Aim,
  type Zone,
} from './placement'

const first = picture({ id: 'a', start: 0, duration: 2_000 })
const later = picture({ id: 'b', start: 5_000, duration: 1_000 })
const below = picture({ id: 'c', start: 1_000, duration: 1_000, track: 1 })
const blocks = [first, later, below]

/** 画面区两行（组件一行、镜头一行），声音区两行；画面块和音频块都有第 0 行。 */
const title = component({ id: 't', start: 500, duration: 1_000, track: 0 })
const shot = picture({ id: 'p', start: 0, duration: 3_000, track: 1 })
const music = audio({ id: 'm', start: 0, duration: 4_000, track: 0 })
const voice = audio({ id: 'v', start: 1_000, duration: 1_000, track: 1 })
const mixed = [voice, shot, music, title]

const layout = (film: readonly FilmBlock[]) =>
  rowsOf(film).map((row) => [row.zone, row.track, row.blocks.map((block) => block.id)])

describe('时间线上的行', () => {
  it('按行分块：行号小的在前，行里按开始时间排', () => {
    expect(layout([later, below, first])).toEqual([
      ['visual', 0, ['a', 'b']],
      ['visual', 1, ['c']],
    ])
  })

  it('画面区在上、声音区在下，各按行号排；两个区的行号互不相干', () => {
    expect(layout(mixed)).toEqual([
      ['visual', 0, ['t']],
      ['visual', 1, ['p']],
      ['audio', 0, ['m']],
      ['audio', 1, ['v']],
    ])
  })

  it('主轨是画面区最上面那一行：音频块的行号再小也不算', () => {
    expect(topTrack([shot, audio({ id: 'm', track: 0 })])).toBe(1)
    expect(topTrack(mixed)).toBe(0)
    expect(topTrack([music])).toBe(0)
  })

  it('一行隐藏着：只看这个区这一行的块', () => {
    const muted = [{ ...music, hidden: true }, picture({ id: 'q', track: 0 })]
    expect(rowHidden(muted, { zone: 'audio', track: 0 })).toBe(true)
    expect(rowHidden(muted, { zone: 'visual', track: 0 })).toBe(false)
    expect(rowHidden(muted, { zone: 'audio', track: 1 })).toBe(false)
  })
})

describe('落在一行的哪个时间', () => {
  it('指针在空处：就放在指针的位置', () => {
    expect(landingOn(blocks, { zone: 'visual', track: 0 }, 2_500, 1_000)).toEqual({
      track: 0,
      start: 2_500,
    })
  })

  it('指针压在别的块上：挪到最近的空位', () => {
    expect(landingOn(blocks, { zone: 'visual', track: 0 }, 1_800, 1_000).start).toBe(2_000)
    expect(landingOn(blocks, { zone: 'visual', track: 0 }, 4_600, 1_000).start).toBe(4_000)
  })

  it('空位不够长：接在这一行最后一个块后面', () => {
    expect(landingOn(blocks, { zone: 'visual', track: 0 }, 2_500, 4_000).start).toBe(6_000)
  })

  it('别的行、别的区同号的行上的块不挡路', () => {
    expect(landingOn(blocks, { zone: 'visual', track: 1 }, 0, 1_000).start).toBe(0)
    expect(landingOn(mixed, { zone: 'visual', track: 0 }, 0, 400).start).toBe(0)
    expect(landingOn(mixed, { zone: 'audio', track: 0 }, 0, 400).start).toBe(4_000)
  })
})

describe('块只落在自己的区', () => {
  const rows = rowsOf(mixed)
  const aimed = (aim: Aim, zone: Zone) => targetIn(rows, aim, zone)

  it('对着自己的区的行：就是那一行', () => {
    expect(aimed({ at: 1 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ at: 3 }, 'audio')).toEqual({ zone: 'audio', track: 1 })
  })

  it('画面区的块对着声音区的行：落在画面区最下面那一行；音频块对着画面区的行：落在声音区最上面那一行', () => {
    expect(aimed({ at: 2 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ at: 3 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ at: 1 }, 'audio')).toEqual({ zone: 'audio', track: 0 })
  })

  it('两个区之间的缝：两种块都能在那里新开一行', () => {
    expect(aimed({ insertAt: 2 }, 'visual')).toEqual({ zone: 'visual', insertAt: 2 })
    expect(aimed({ insertAt: 2 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
  })

  it('别的区里两行之间的缝：不新开，落在自己的区挨着的那一行', () => {
    expect(aimed({ insertAt: 3 }, 'visual')).toEqual({ zone: 'visual', track: 1 })
    expect(aimed({ insertAt: 1 }, 'audio')).toEqual({ zone: 'audio', track: 0 })
    expect(aimed({ insertAt: 1 }, 'visual')).toEqual({ zone: 'visual', insertAt: 1 })
    expect(aimed({ insertAt: 3 }, 'audio')).toEqual({ zone: 'audio', insertAt: 3 })
  })

  it('最下面那条空行：音频块在那里新开一行；画面区的块在画面区的最下面新开一行', () => {
    expect(aimed({ insertAt: 4 }, 'audio')).toEqual({ zone: 'audio', insertAt: 4 })
    expect(aimed({ insertAt: 4 }, 'visual')).toEqual({ zone: 'visual', insertAt: 2 })
  })

  it('最上面（指针在时间尺上也算）：画面区的块在那里新开一行；音频块在声音区的最上面新开一行', () => {
    expect(aimed({ insertAt: 0 }, 'visual')).toEqual({ zone: 'visual', insertAt: 0 })
    expect(aimed({ insertAt: 0 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
  })

  it('画面区还没有行：镜头对着声音区的行或最下面，都在最上面新开画面区的第一行', () => {
    const audioOnly = rowsOf([music, voice])
    expect(targetIn(audioOnly, { at: 1 }, 'visual')).toEqual({ zone: 'visual', insertAt: 0 })
    expect(targetIn(audioOnly, { insertAt: 2 }, 'visual')).toEqual({ zone: 'visual', insertAt: 0 })
  })

  it('声音区还没有行：画面区的块哪里都能新开，音频块对着画面区的行时在最下面新开声音区的第一行', () => {
    const visualOnly = rowsOf([title, shot])
    expect(targetIn(visualOnly, { insertAt: 2 }, 'visual')).toEqual({
      zone: 'visual',
      insertAt: 2,
    })
    expect(targetIn(visualOnly, { at: 0 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
    // 音频拖到画面行之间的缝、最下面那条空行，也是新开声音区的第一行
    expect(targetIn(visualOnly, { insertAt: 1 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
    expect(targetIn(visualOnly, { insertAt: 2 }, 'audio')).toEqual({ zone: 'audio', insertAt: 2 })
  })
})

describe('新开一行', () => {
  const opened = (film: FilmBlock[], zone: Zone, insertAt: number, movedId?: string) => {
    const { track, renumber } = rowOpening(film, zone, insertAt, movedId)
    return { track, renumber: [...renumber] }
  }

  it('开在最上面：新的一行是 0 号，别的行都往后排一号', () => {
    expect(opened(blocks, 'visual', 0)).toEqual({
      track: 0,
      renumber: [
        ['a', 1],
        ['b', 1],
        ['c', 2],
      ],
    })
  })

  it('开在两行之间：上面的行不动，下面的行往后排一号', () => {
    expect(opened(blocks, 'visual', 1)).toEqual({ track: 1, renumber: [['c', 2]] })
  })

  it('开在最下面：别的行都不动', () => {
    expect(opened(blocks, 'visual', 2)).toEqual({ track: 2, renumber: [] })
  })

  it('行号原来有空着的：顺带从 0 起连着排', () => {
    const gapped = [
      picture({ id: 'a', track: 2 }),
      picture({ id: 'b', track: 5 }),
      picture({ id: 'c', track: 9 }),
    ]
    expect(opened(gapped, 'visual', 2)).toEqual({
      track: 2,
      renumber: [
        ['a', 0],
        ['b', 1],
        ['c', 3],
      ],
    })
  })

  it('只在同一个区里顺延：声音区开在两行之间，声音区下面的行往后排，画面区不动', () => {
    // 时间线上第 3 行的位置是声音区第 0 行和第 1 行之间
    expect(opened(mixed, 'audio', 3)).toEqual({ track: 1, renumber: [['v', 2]] })
    // 在两个区之间为声音区开：声音区的行都往后排一号
    expect(opened(mixed, 'audio', 2)).toEqual({
      track: 0,
      renumber: [
        ['m', 1],
        ['v', 2],
      ],
    })
    // 同一个位置为画面区开：是画面区最下面的新一行，声音区不动
    expect(opened(mixed, 'visual', 2)).toEqual({ track: 2, renumber: [] })
  })

  it('搬进新行的块原来那一行只剩它：那一行不再算，位置按挪之前时间线上的第几行', () => {
    // c 自己占着第 2 行，搬到最上面：a、b 那一行排到 1 号，c 原来那一行空出来
    expect(opened(blocks, 'visual', 0, 'c')).toEqual({
      track: 0,
      renumber: [
        ['a', 1],
        ['b', 1],
      ],
    })
    // 搬到自己这一行的上面或下面那道缝：还是原来的号，别的块也不用动
    expect(opened(blocks, 'visual', 1, 'c')).toEqual({ track: 1, renumber: [] })
    expect(opened(blocks, 'visual', 2, 'c')).toEqual({ track: 1, renumber: [] })
    // 声音区独占一行的音频块搬到自己上下的缝里也一样
    expect(opened(mixed, 'audio', 3, 'v')).toEqual({ track: 1, renumber: [] })
    expect(opened(mixed, 'audio', 4, 'v')).toEqual({ track: 1, renumber: [] })
  })

  it('搬进新行的块原来那一行还有别的块：那一行照常算', () => {
    expect(opened(blocks, 'visual', 1, 'b')).toEqual({ track: 1, renumber: [['c', 2]] })
  })
})
