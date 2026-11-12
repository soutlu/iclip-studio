import { describe, expect, it } from 'vitest'
import { picture } from '@/testing/whole-film'
import { insertionOf } from './stacking'

describe('放进成片的块写在哪、叠放顺序是多少', () => {
  const top = picture({ id: 'top', start: 0, duration: 4_000, track: 0 })
  const below = picture({ id: 'below', start: 0, duration: 4_000, track: 2 })

  it('放在最上面一行：写在最后，盖住下面的块', () => {
    const added = picture({ id: 'new', start: 1_500, duration: 1_000, track: 0 })
    expect(insertionOf([below], added)).toEqual({ index: 1, z: 0 })
  })

  it('放在下面一行、和上面的块重叠：写在那个块前面，被它盖住', () => {
    const added = picture({ id: 'new', start: 3_500, duration: 1_000, track: 1 })
    expect(insertionOf([top], added)).toEqual({ index: 0, z: 0 })
  })

  it('夹在中间一行：写在上面的块之前；这样还盖不住下面的块时把叠放顺序调高', () => {
    const added = picture({ id: 'new', start: 500, duration: 1_000, track: 1 })
    // 文件里 below 在前、top 在后：写在两者之间，不用调
    expect(insertionOf([below, top], added)).toEqual({ index: 1, z: 0 })
    // 文件里 top 在前、below 在后：写在 top 前面就排到 below 前面了，得调高才盖得住它
    expect(insertionOf([top, below], added)).toEqual({ index: 0, z: 1 })
  })

  it('下面的块自己带着叠放顺序：调到比它高 1', () => {
    const added = picture({ id: 'new', start: 500, duration: 1_000, track: 0 })
    expect(insertionOf([{ ...below, z: 4 }], added)).toEqual({ index: 1, z: 5 })
  })

  it('原来带着的叠放顺序不保留，按新位置重新算', () => {
    const moved = picture({ id: 'new', start: 500, duration: 1_000, track: 1, z: 7 })
    expect(insertionOf([top], moved)).toEqual({ index: 0, z: 0 })
  })

  it('和谁都不重叠：写在最后', () => {
    const added = picture({ id: 'new', start: 20_000, duration: 1_000, track: 1 })
    expect(insertionOf([top, below], added)).toEqual({ index: 2, z: 0 })
  })
})
