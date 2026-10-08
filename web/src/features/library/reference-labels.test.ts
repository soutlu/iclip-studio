import { describe, expect, it } from 'vitest'
import { failureMessageOf, referenceTitleOf, type VideoTypeLabels } from './reference-labels'

const LABELS: VideoTypeLabels = new Map([
  ['try_on', '上身展示'],
  ['review', '开箱测评'],
])

describe('referenceTitleOf', () => {
  it('拆完的：片子类型的名称在前、品类在后，用「 · 」连起来', () => {
    expect(
      referenceTitleOf(
        { breakdownStatus: 'completed', categories: ['拖鞋'], videoTypes: ['review', 'try_on'] },
        LABELS,
      ),
    ).toEqual({ placeholder: false, text: '开箱测评 · 上身展示 · 拖鞋' })
  })

  it('名称表里没有的取值不显示，不把取值原文给人看', () => {
    expect(
      referenceTitleOf(
        { breakdownStatus: 'completed', categories: [], videoTypes: ['drama'] },
        LABELS,
      ).text,
    ).not.toContain('drama')
  })

  it.each(['completed', 'failed'] as const)('%s 且没有标签：未标注', (breakdownStatus) => {
    expect(referenceTitleOf({ breakdownStatus, categories: [], videoTypes: [] }, LABELS)).toEqual({
      placeholder: true,
      text: '未标注',
    })
  })

  it.each(['pending', 'running'] as const)('%s：还没拆完，不当未标注', (breakdownStatus) => {
    const title = referenceTitleOf({ breakdownStatus, categories: [], videoTypes: [] }, LABELS)
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
