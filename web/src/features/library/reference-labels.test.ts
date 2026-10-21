import { describe, expect, it } from 'vitest'
import { mockLibraryTagTree, mockTagId } from '@/testing/mocks/library-tags'
import { tagIndexOf } from './library-tags'
import { failureMessageOf, referenceTitleOf, taggingFailureOf } from './reference-labels'

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

describe('failureMessageOf', () => {
  const CODES = ['video_unreadable', 'model_call_failed', 'model_failed', 'timeout'] as const

  it('每种失败原因一句不同的话，不带原因的代码', () => {
    const messages = CODES.map((code) => failureMessageOf(code, false))
    expect(new Set(messages).size).toBe(CODES.length)
    messages.forEach((message, index) => expect(message).not.toContain(CODES[index]))
  })

  it('有上一次的拆解时说明下面还是上一次的', () => {
    expect(failureMessageOf('model_call_failed', true)).not.toBe(
      failureMessageOf('model_call_failed', false),
    )
  })
})

describe('taggingFailureOf', () => {
  const CODES = ['no_source_text', 'model_call_failed', 'model_failed', 'timeout'] as const

  it('每种原因一句不同的话，不带原因的代码', () => {
    const messages = CODES.map((code) => taggingFailureOf(code, true))
    expect(new Set(messages).size).toBe(CODES.length)
    messages.forEach((message, index) => expect(message).not.toContain(CODES[index]))
  })

  it('能重新打标才请人点「重新打标」', () => {
    expect(taggingFailureOf('timeout', true)).toContain('「重新打标」')
    expect(taggingFailureOf('timeout', false)).not.toContain('「重新打标」')
  })
})
