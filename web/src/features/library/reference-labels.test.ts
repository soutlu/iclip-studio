import { describe, expect, it } from 'vitest'
import { mockLibraryTagTree, mockTagId } from '@/testing/mocks/library-tags'
import { tagIndexOf } from './library-tags'
import { referenceTitleOf } from './reference-labels'

const INDEX = tagIndexOf(mockLibraryTagTree())

describe('referenceTitleOf', () => {
  it('有标签：标签名按树的先后，用「 · 」连起来', () => {
    expect(
      referenceTitleOf(
        {
          breakdownStatus: 'completed',
          tagIds: [mockTagId('标准开箱流程'), mockTagId('拖鞋')],
          tagStatus: 'completed',
        },
        INDEX,
      ),
    ).toEqual({ placeholder: false, text: '拖鞋 · 标准开箱流程' })
  })

  it('树里没有的 id 不显示，不把 id 给人看', () => {
    const unknown = '00000000-0000-4000-8000-000000000000'
    expect(
      referenceTitleOf(
        { breakdownStatus: 'completed', tagIds: [unknown], tagStatus: 'completed' },
        INDEX,
      ),
    ).toEqual({ placeholder: true, text: '未标注' })
  })

  it.each([
    ['completed', 'completed'],
    ['completed', 'failed'],
    ['failed', null],
  ] as const)('拆解 %s、打标 %s 且没有标签：未标注', (breakdownStatus, tagStatus) => {
    expect(referenceTitleOf({ breakdownStatus, tagIds: [], tagStatus }, INDEX)).toEqual({
      placeholder: true,
      text: '未标注',
    })
  })

  it.each([
    ['pending', null],
    ['running', null],
    ['completed', 'pending'],
    ['completed', 'running'],
  ] as const)('拆解 %s、打标 %s：还没打完，不当未标注', (breakdownStatus, tagStatus) => {
    const title = referenceTitleOf({ breakdownStatus, tagIds: [], tagStatus }, INDEX)
    expect(title.placeholder).toBe(true)
    expect(title.text).not.toBe('未标注')
  })
})
