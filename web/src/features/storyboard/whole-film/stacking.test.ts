import { describe, expect, it } from 'vitest'
import { audio, component, picture } from '@/testing/whole-film'
import { newBlockZ, restackedZ, rowMoveDirection } from './stacking'

describe('新加的片段的叠放顺序', () => {
  it('空成片里加第一个片段：1', () => {
    expect(newBlockZ([], 0)).toBe(1)
  })

  it('按文件里所有的片段数算，组件或块的片段和音频片段也算；一次加几个时每个各算各的', () => {
    const existing = [picture({ id: 'a' }), component(), audio()]
    expect(newBlockZ(existing, 0)).toBe(4)
    expect(newBlockZ(existing, 1)).toBe(5)
    expect(newBlockZ(existing, 2)).toBe(6)
  })
})

describe('换行以后被挪的片段的叠放顺序', () => {
  it('往上挪：抬到它压着的、时间上重叠的片段之上', () => {
    const moved = picture({ id: 'moved', start: 500, track: 0 })
    const under = picture({ id: 'under', track: 1, z: 2 })
    expect(restackedZ([moved, under], 'moved', 'up')).toBe(3)
  })

  it('往上挪、本来就盖着它压着的片段：不改', () => {
    const under = picture({ id: 'under', track: 1 })
    const moved = picture({ id: 'moved', start: 500, track: 0 })
    expect(restackedZ([under, moved], 'moved', 'up')).toBeUndefined()
  })

  it('往上挪：组件或块的片段也算，音频片段不算', () => {
    const moved = picture({ id: 'moved', start: 500, track: 0 })
    const title = component({ track: 1, z: 4 })
    const music = audio({ track: 1 })
    expect(restackedZ([moved, title, music], 'moved', 'up')).toBe(5)
    expect(restackedZ([moved, music], 'moved', 'up')).toBeUndefined()
  })

  it('往下挪：降到盖着它的、时间上重叠的片段之下', () => {
    const over = picture({ id: 'over', track: 0, z: 4 })
    const moved = picture({ id: 'moved', start: 500, track: 1, z: 6 })
    expect(restackedZ([over, moved], 'moved', 'down')).toBe(3)
  })

  it('往下挪：最低降到 0', () => {
    const over = picture({ id: 'over', track: 0, z: 1 })
    const moved = picture({ id: 'moved', start: 500, track: 1, z: 3 })
    expect(restackedZ([moved, over], 'moved', 'down')).toBe(0)
  })

  it('往下挪、叠放顺序全是 0、它写在后面：降不下去，不改', () => {
    const over = picture({ id: 'over', track: 0 })
    const moved = picture({ id: 'moved', start: 500, track: 1 })
    expect(restackedZ([over, moved], 'moved', 'down')).toBeUndefined()
  })

  it('时间上不重叠的片段不算：首尾相接也不算重叠', () => {
    const moved = picture({ id: 'moved', start: 2_000, track: 0 })
    const before = picture({ id: 'before', start: 0, duration: 2_000, track: 1, z: 7 })
    const later = picture({ id: 'later', start: 9_000, track: 1, z: 9 })
    const under = picture({ id: 'under', start: 3_000, track: 1, z: 2 })
    expect(restackedZ([moved, before, later], 'moved', 'up')).toBeUndefined()
    expect(restackedZ([moved, before, later, under], 'moved', 'up')).toBe(3)
  })
})

describe('换行的方向', () => {
  // 行号 0、3、5 三行，b 在 3 号行
  const pictures = [
    picture({ id: 'a', track: 0 }),
    picture({ id: 'b', track: 3 }),
    picture({ id: 'c', start: 4_000, track: 3 }),
    picture({ id: 'd', track: 5 }),
  ]

  const visual = (track: number) => ({ zone: 'visual', track }) as const
  const opening = (insertAt: number) => ({ zone: 'visual', insertAt }) as const

  it('换到已有的行：在上面是往上，在下面是往下（按第几行比，行号不连着也一样）', () => {
    expect(rowMoveDirection(pictures, 'b', visual(0))).toBe('up')
    expect(rowMoveDirection(pictures, 'b', visual(5))).toBe('down')
  })

  it('新开一行：开在它这一行之上是往上，之下是往下', () => {
    expect(rowMoveDirection(pictures, 'b', opening(0))).toBe('up')
    expect(rowMoveDirection(pictures, 'b', opening(2))).toBe('down')
    expect(rowMoveDirection(pictures, 'b', opening(3))).toBe('down')
  })

  it('在它这一行紧上面新开一行：不调叠放顺序', () => {
    expect(rowMoveDirection(pictures, 'b', opening(1))).toBeNull()
  })

  it('独占一行的片段拖到自己上下的缝里：行号不变，紧上面不调叠放顺序，紧下面照往下挪算', () => {
    expect(rowMoveDirection(pictures, 'd', opening(2))).toBeNull()
    expect(rowMoveDirection(pictures, 'd', opening(3))).toBe('down')
  })

  it('按时间线上的第几行比：声音区的行排在画面区下面，同号也分得开', () => {
    const film = [...pictures, audio({ id: 'm', track: 0 }), audio({ id: 'n', track: 1 })]
    expect(rowMoveDirection(film, 'm', { zone: 'audio', track: 1 })).toBe('down')
    expect(rowMoveDirection(film, 'n', { zone: 'audio', track: 0 })).toBe('up')
    expect(rowMoveDirection(film, 'n', { zone: 'audio', insertAt: 4 })).toBeNull()
  })
})
