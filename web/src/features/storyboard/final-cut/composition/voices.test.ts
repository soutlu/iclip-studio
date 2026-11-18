import { describe, expect, it } from 'vitest'
import {
  localizedVoices,
  voiceModeOf,
  voiceModesAttribute,
  voiceModesOf,
  voiceModesWithout,
  voiceOfLine,
  voiceSettingOf,
  withLineVoice,
  type VoiceElement,
  type VoiceSetting,
} from './voices'

const DUB: VoiceSetting = { mode: 'dub', voice: null, lines: {} }

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
    expect(
      localizedVoices(ELEMENTS, { en: { ...DUB, mode: 'original', voice: 'v-1' } }, 'en'),
    ).toEqual([
      { index: 3, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('只写了语言、没写配哪句的音频不算配音片段', () => {
    const halfway = [{ tag: 'audio', attributes: { id: 'x', src: 'x.m4a', 'data-locale': 'en' } }]
    expect(localizedVoices(halfway, { en: DUB }, null)).toEqual([])
  })

  describe('原文的旁白（只写了配哪句、没写语言的配音片段）', () => {
    const narration: VoiceElement = {
      tag: 'audio',
      attributes: { id: 'n', src: 'n.m4a', 'data-dub-of': 'cap-n', 'data-dub-voice': 'v-1' },
    }
    const elements = [video(), narration, dub('en')]

    it('原文下出声', () => {
      expect(localizedVoices(elements, { en: DUB }, null)).toEqual([{ index: 2, remove: true }])
    })

    it('保留原声的语言下出声', () => {
      expect(localizedVoices(elements, { en: DUB }, 'de')).toEqual([{ index: 2, remove: true }])
    })

    it('AI 配音的语言下不出声，出声的是这种语言的配音', () => {
      expect(localizedVoices(elements, { en: DUB }, 'en')).toEqual([
        { index: 0, remove: false, attributes: MUTED },
        { index: 1, remove: true },
      ])
    })
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
      es: { mode: 'original', voice: 'v-1', lines: {} },
      zh: { mode: 'dub', voice: 'v-2', lines: {} },
    })
    expect(voiceModeOf(modes, 'en')).toBe('dub')
    expect(voiceModeOf(modes, 'es')).toBe('original')
    expect(voiceSettingOf(modes, 'zh')).toEqual({ mode: 'dub', voice: 'v-2', lines: {} })
    expect(voiceSettingOf(modes, 'de')).toEqual({ mode: 'original', voice: null, lines: {} })
    expect(voiceModeOf(modes, null)).toBe('original')
    for (const json of [undefined, '', '[]', 'null', '{oops'])
      expect(voiceModesOf(json)).toEqual({})
  })

  it('各句的选择：音色、原声的音色、不配音；写法不对的句子当没选过', () => {
    const modes = voiceModesOf(
      JSON.stringify({
        en: {
          mode: 'dub',
          voice: 'v-1',
          lines: {
            'cap-a': { voice: 'v-2' },
            'cap-b': { voice: null },
            'cap-c': { dub: false },
            'cap-d': { dub: true },
            'cap-e': { voice: '' },
            'cap-f': 'v-2',
          },
        },
        de: { mode: 'dub', voice: null, lines: 'oops' },
      }),
    )
    expect(modes).toEqual({
      en: {
        mode: 'dub',
        voice: 'v-1',
        lines: { 'cap-a': { voice: 'v-2' }, 'cap-b': { voice: null }, 'cap-c': { dub: false } },
      },
      de: DUB,
    })
    const english = voiceSettingOf(modes, 'en')
    expect(
      ['cap-a', 'cap-b', 'cap-c', 'cap-z'].map((caption) => voiceOfLine(english, caption)),
    ).toEqual(['v-2', null, undefined, 'v-1'])
  })

  it('写回：保留原声时音色还记着；默认设置的语言不写，有句子选过的保留原声的语言也写；lines 空着不写', () => {
    expect(voiceModesAttribute({ en: DUB, de: DUB })).toBe(
      '{"en":{"mode":"dub","voice":null},"de":{"mode":"dub","voice":null}}',
    )
    expect(voiceModesAttribute({ en: { ...DUB, mode: 'original' } })).toBeNull()
    expect(voiceModesAttribute({ en: { mode: 'original', voice: 'v-1', lines: {} } })).toBe(
      '{"en":{"mode":"original","voice":"v-1"}}',
    )
    const muted = withLineVoice({ ...DUB, mode: 'original' }, 'cap-a', { dub: false })
    expect(voiceModesAttribute({ en: muted })).toBe(
      '{"en":{"mode":"original","voice":null,"lines":{"cap-a":{"dub":false}}}}',
    )
    expect(voiceModesAttribute({ en: withLineVoice(muted, 'cap-a', null) })).toBeNull()
    expect(voiceModesOf(voiceModesAttribute({ en: muted }) ?? undefined)).toEqual({ en: muted })
  })

  it('改一句的选择：别的句子不动，换掉它原来的选择', () => {
    const setting = withLineVoice(withLineVoice(DUB, 'cap-a', { voice: 'v-1' }), 'cap-b', {
      dub: false,
    })
    expect(withLineVoice(setting, 'cap-a', { voice: null }).lines).toEqual({
      'cap-a': { voice: null },
      'cap-b': { dub: false },
    })
    expect(withLineVoice(setting, 'cap-b', null).lines).toEqual({ 'cap-a': { voice: 'v-1' } })
  })

  it('删一句字幕：各语言里它的选择都去掉；哪种语言都没记着它时原样答复', () => {
    const modes = {
      en: withLineVoice(DUB, 'cap-a', { voice: 'v-1' }),
      de: withLineVoice(withLineVoice(DUB, 'cap-a', { dub: false }), 'cap-b', { dub: false }),
    }
    expect(voiceModesWithout(modes, 'cap-a')).toEqual({
      en: DUB,
      de: withLineVoice(DUB, 'cap-b', { dub: false }),
    })
    expect(voiceModesWithout(modes, 'cap-z')).toBe(modes)
  })
})
