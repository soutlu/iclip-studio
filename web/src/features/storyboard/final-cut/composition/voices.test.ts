import { describe, expect, it } from 'vitest'
import {
  localizedVoices,
  voiceModeOf,
  voiceModesAttribute,
  voiceModesOf,
  type VoiceElement,
} from './voices'

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
    expect(localizedVoices(ELEMENTS, { en: 'dub' }, null)).toEqual([
      { index: 3, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('AI 配音：只留这种语言的配音，视频关掉原声，分离出来的原声去掉；配乐、贴片不动', () => {
    expect(localizedVoices(ELEMENTS, { en: 'dub' }, 'en')).toEqual([
      { index: 0, remove: false, attributes: MUTED },
      { index: 1, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('AI 配音时本来就关了原声的视频不动', () => {
    expect(localizedVoices([video({ muted: '' })], { en: 'dub' }, 'en')).toEqual([])
  })

  it('保留原声：这种语言的配音也去掉，原声照常', () => {
    expect(localizedVoices(ELEMENTS, { en: 'dub' }, 'de')).toEqual([
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
  it('只认写成 dub 的语言；没写、写法不对时都是保留原声，原文总是保留原声', () => {
    const modes = voiceModesOf('{"en":"dub","de":"original","fr":1}')
    expect(modes).toEqual({ en: 'dub' })
    expect(voiceModeOf(modes, 'en')).toBe('dub')
    expect(voiceModeOf(modes, 'de')).toBe('original')
    expect(voiceModeOf(modes, null)).toBe('original')
    for (const json of [undefined, '', '[]', 'null', '{oops'])
      expect(voiceModesOf(json)).toEqual({})
  })

  it('改一种语言的设置：别的语言不动；都保留原声时去掉这个属性', () => {
    expect(voiceModesAttribute({ en: 'dub' }, 'de', 'dub')).toBe('{"en":"dub","de":"dub"}')
    expect(voiceModesAttribute({ en: 'dub' }, 'en', 'original')).toBeNull()
  })
})
