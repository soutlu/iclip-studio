import { describe, expect, it } from 'vitest'
import {
  localizedVoices,
  voiceModeOf,
  voiceModesAttribute,
  voiceModesOf,
  voiceSettingOf,
  type VoiceElement,
  type VoiceSetting,
} from './voices'

const DUB: VoiceSetting = { mode: 'dub', voice: null }

const video = (extra: Record<string, string> = {}): VoiceElement => ({
  tag: 'video',
  attributes: { id: 'v', src: 'a.mp4', 'data-has-audio': 'true', ...extra },
})
const detached: VoiceElement = {
  tag: 'audio',
  attributes: { id: 'o', src: 'a.mp4', 'data-sync-origin': 'pair' },
}
const music: VoiceElement = { tag: 'audio', attributes: { id: 'm', src: 'music.mp3' } }
const dub = (locale: string): VoiceElement => ({
  tag: 'audio',
  attributes: { id: locale, src: `${locale}.m4a`, 'data-locale': locale, 'data-dub-of': 'cap-a1' },
})
const host: VoiceElement = { tag: 'div', attributes: { id: 'h', 'data-composition-id': 'title' } }

const ELEMENTS = [video(), detached, music, dub('en'), dub('de'), host]
const MUTED = { muted: 'true', 'data-has-audio': null }

describe('localizedVoices', () => {
  it('原文：配音片段都去掉，原声照常', () => {
    expect(localizedVoices(ELEMENTS, { en: DUB }, null)).toEqual([
      { index: 3, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('AI 配音：只留这种语言的配音，视频关掉原声，分离出来的原声去掉；配乐、贴片不动', () => {
    expect(localizedVoices(ELEMENTS, { en: DUB }, 'en')).toEqual([
      { index: 0, remove: false, attributes: MUTED },
      { index: 1, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('AI 配音时本来就关了原声的视频不动', () => {
    expect(localizedVoices([video({ muted: '' })], { en: DUB }, 'en')).toEqual([])
  })

  it('保留原声：这种语言的配音也去掉，原声照常；记着音色也一样', () => {
    expect(localizedVoices(ELEMENTS, { en: DUB }, 'de')).toEqual([
      { index: 3, remove: true },
      { index: 4, remove: true },
    ])
    expect(localizedVoices(ELEMENTS, { en: { mode: 'original', voice: 'v-1' } }, 'en')).toEqual([
      { index: 3, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('只写了语言或只写了配哪句的音频不算配音片段', () => {
    const halfway = [
      { tag: 'audio', attributes: { id: 'x', src: 'x.m4a', 'data-locale': 'en' } },
      { tag: 'audio', attributes: { id: 'y', src: 'y.m4a', 'data-dub-of': 'cap-a1' } },
    ]
    expect(localizedVoices(halfway, {}, null)).toEqual([])
  })
})

describe('人声设置的读写', () => {
  it('每种语言写着设置和音色（null 是原声的音色）；没写、写法不对时都是保留原声、原声的音色', () => {
    const modes = voiceModesOf(
      '{"en":{"mode":"dub","voice":null},"es":{"mode":"original","voice":"v-1"},' +
        '"zh":{"mode":"dub","voice":"v-2"},"de":"dub","fr":1,"ja":{"mode":"dub"},' +
        '"ko":{"mode":"loud","voice":"v"},"it":{"mode":"dub","voice":""}}',
    )
    expect(modes).toEqual({
      en: DUB,
      es: { mode: 'original', voice: 'v-1' },
      zh: { mode: 'dub', voice: 'v-2' },
    })
    expect(voiceModeOf(modes, 'en')).toBe('dub')
    expect(voiceModeOf(modes, 'es')).toBe('original')
    expect(voiceSettingOf(modes, 'zh')).toEqual({ mode: 'dub', voice: 'v-2' })
    expect(voiceSettingOf(modes, 'de')).toEqual({ mode: 'original', voice: null })
    expect(voiceModeOf(modes, null)).toBe('original')
    for (const json of [undefined, '', '[]', 'null', '{oops'])
      expect(voiceModesOf(json)).toEqual({})
  })

  it('改一种语言的设置：别的语言不动；保留原声时音色还记着；都是默认设置时去掉这个属性', () => {
    expect(voiceModesAttribute({ en: DUB }, 'de', DUB)).toBe(
      '{"en":{"mode":"dub","voice":null},"de":{"mode":"dub","voice":null}}',
    )
    expect(voiceModesAttribute({ en: DUB }, 'en', { mode: 'original', voice: null })).toBeNull()
    expect(voiceModesAttribute({ en: DUB }, 'en', { mode: 'original', voice: 'v-1' })).toBe(
      '{"en":{"mode":"original","voice":"v-1"}}',
    )
    expect(voiceModesAttribute({ en: { mode: 'dub', voice: 'v-1' } }, 'de', DUB)).toBe(
      '{"en":{"mode":"dub","voice":"v-1"},"de":{"mode":"dub","voice":null}}',
    )
  })
})
