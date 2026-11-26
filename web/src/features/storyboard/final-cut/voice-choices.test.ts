import { describe, expect, it } from 'vitest'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { commonVoices, voicePickerFilter } from './voice-choices'

/** 资料库里的一条音色：只有编号和语种要紧。 */
const voice = (id: string, locale: ReferenceAudio['locale']) => ({ id, locale }) as ReferenceAudio

// 新的在前
const LIBRARY = [
  voice('nova', null),
  voice('klaus', 'de'),
  voice('ava', 'en'),
  voice('emma', 'en'),
  voice('narrator', null),
]

describe('常用音色', () => {
  it('还没用过音色：用这种语言和没设语种的资料库音色，按资料库的先后补到 3 个', () => {
    expect(commonVoices([null], LIBRARY, 'en')).toEqual(['nova', 'ava', 'emma'])
    expect(commonVoices([], LIBRARY, 'de')).toEqual(['nova', 'klaus', 'narrator'])
  })

  it('用过的排在前面（整体音色、再各句的），去掉原声和重复的，不管它是哪种语言、资料库里还有没有', () => {
    expect(commonVoices(['klaus', null, 'gone', 'klaus'], LIBRARY, 'en')).toEqual([
      'klaus',
      'gone',
      'nova',
    ])
  })

  it('用过的超过 3 个：只留前 3 个', () => {
    expect(commonVoices(['a', 'b', 'c', 'd'], LIBRARY, 'en')).toEqual(['a', 'b', 'c'])
  })

  it('资料库里没有可补的：有几个是几个', () => {
    expect(commonVoices([undefined], [voice('klaus', 'de')], 'en')).toEqual([])
  })
})

describe('选音面板的查询', () => {
  it('选某个语种：连带多语种；只查音色，关键词去掉两头空白', () => {
    expect(voicePickerFilter({ locale: 'en', q: '  温柔 ', traits: {} })).toEqual({
      audioKind: 'voice',
      q: '温柔',
      locale: ['en', 'none'],
    })
  })

  it('多语种只查没设语种的；全部不按语种筛', () => {
    expect(voicePickerFilter({ locale: 'none', q: '', traits: {} })).toEqual({
      audioKind: 'voice',
      q: '',
      locale: ['none'],
    })
    expect(voicePickerFilter({ locale: 'all', q: '', traits: {} })).toEqual({
      audioKind: 'voice',
      q: '',
    })
  })

  it('带上场景、性别、年龄里选了的，空的不带', () => {
    expect(
      voicePickerFilter({
        locale: 'all',
        q: '',
        traits: { scenario: ['documentaries', 'trailers'], gender: ['male'], age: [] },
      }),
    ).toEqual({
      audioKind: 'voice',
      q: '',
      scenario: ['documentaries', 'trailers'],
      gender: ['male'],
    })
  })
})
