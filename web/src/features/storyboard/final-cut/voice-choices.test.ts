import { describe, expect, it } from 'vitest'
import { voicePickerFilter } from './voice-choices'

describe('选音浮层的查询', () => {
  it('选某个语种：连带多语种；只查音色，关键词去掉两头空白', () => {
    expect(voicePickerFilter({ locale: 'en', gender: 'all', q: '  温柔 ' })).toEqual({
      audioKind: 'voice',
      q: '温柔',
      locale: ['en', 'none'],
    })
  })

  it('多语种只查没设语种的；全部不按语种筛', () => {
    expect(voicePickerFilter({ locale: 'none', gender: 'all', q: '' })).toEqual({
      audioKind: 'voice',
      q: '',
      locale: ['none'],
    })
    expect(voicePickerFilter({ locale: 'all', gender: 'all', q: '' })).toStrictEqual({
      audioKind: 'voice',
      q: '',
    })
  })

  it('选了女声或男声：按它筛；不限不带', () => {
    expect(voicePickerFilter({ locale: 'all', gender: 'male', q: '' })).toStrictEqual({
      audioKind: 'voice',
      q: '',
      gender: ['male'],
    })
  })
})
