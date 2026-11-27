import { describe, expect, it } from 'vitest'
import {
  localizedVoices,
  ownedCaptions,
  SOURCE_VOICES,
  voiceKeyOf,
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

/** 原文下的配音片段（不写语言）：`caption` 是配的哪句。 */
const sourceDub = (id: string, caption: string): VoiceElement => ({
  tag: 'audio',
  attributes: { id, src: `${id}.m4a`, 'data-dub-of': caption, 'data-dub-voice': 'v-1' },
})

// 0 视频、1 分离出来的原声、2 配乐、3 English 配音、4 Deutsch 配音、5 元素片段、6 原文下给视频句配的音、7 旁白
const ELEMENTS = [
  video(),
  detached,
  music,
  dub('en'),
  dub('de'),
  host,
  sourceDub('s', 'cap-a1'),
  sourceDub('n', 'cap-n'),
]
/** cap-a1 属于视频片段，cap-n 不属于（手动加的，原文下的配音是旁白）。 */
const OWNED: ReadonlySet<string> = new Set(['cap-a1'])
const MUTED = { muted: 'true', 'data-has-audio': null }

describe('localizedVoices', () => {
  it('原文原声：外语配音都去掉，原文下视频句的配音不出声，旁白出声，原声照常', () => {
    expect(localizedVoices(ELEMENTS, { en: DUB }, null, OWNED)).toEqual([
      { index: 3, remove: true },
      { index: 4, remove: true },
      { index: 6, remove: true },
    ])
  })

  it('原文配音：原文下的配音（视频句和旁白）都出声，外语配音去掉，视频关掉原声，分离出来的原声去掉', () => {
    expect(localizedVoices(ELEMENTS, { [SOURCE_VOICES]: DUB }, null, OWNED)).toEqual([
      { index: 0, remove: false, attributes: MUTED },
      { index: 1, remove: true },
      { index: 3, remove: true },
      { index: 4, remove: true },
    ])
  })

  it('外语配音：只留这种语言的配音，原文下的都去掉，视频关掉原声，分离出来的原声去掉；配乐、元素片段不动', () => {
    expect(localizedVoices(ELEMENTS, { en: DUB }, 'en', OWNED)).toEqual([
      { index: 0, remove: false, attributes: MUTED },
      { index: 1, remove: true },
      { index: 4, remove: true },
      { index: 6, remove: true },
      { index: 7, remove: true },
    ])
  })

  it('外语原声：和原文原声放的一样（原声和旁白）；记着音色、原文在配音时也一样', () => {
    const asSource = [
      { index: 3, remove: true },
      { index: 4, remove: true },
      { index: 6, remove: true },
    ]
    expect(localizedVoices(ELEMENTS, { en: DUB }, 'de', OWNED)).toEqual(asSource)
    expect(
      localizedVoices(
        ELEMENTS,
        { en: { ...DUB, mode: 'original', voice: 'v-1' }, [SOURCE_VOICES]: DUB },
        'en',
        OWNED,
      ),
    ).toEqual(asSource)
  })

  it('配音时本来就关了原声的视频不动', () => {
    expect(localizedVoices([video({ muted: '' })], { en: DUB }, 'en', OWNED)).toEqual([])
  })

  it('只写了语言、没写配哪句的音频不算配音片段', () => {
    const halfway = [{ tag: 'audio', attributes: { id: 'x', src: 'x.m4a', 'data-locale': 'en' } }]
    expect(localizedVoices(halfway, { en: DUB }, null, OWNED)).toEqual([])
  })
})

describe('ownedCaptions', () => {
  it('写了存在的视频片段的字幕属于它；没写的、写的视频片段不在了的不属于（是旁白句）', () => {
    expect(
      ownedCaptions(
        [
          { id: 'cap-a', owner: 'clip-1' },
          { id: 'cap-b', owner: null },
          { id: 'cap-c', owner: 'clip-gone' },
        ],
        ['clip-1', 'clip-2'],
      ),
    ).toEqual(new Set(['cap-a']))
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

  it('原文的设置记在 _source 键下，和语言代码分开', () => {
    const modes = voiceModesOf(
      '{"_source":{"mode":"dub","voice":"v-1","lines":{"cap-n":{"voice":"v-2"}}},"zh":{"mode":"dub","voice":null}}',
    )
    expect(voiceSettingOf(modes, null)).toEqual({
      mode: 'dub',
      voice: 'v-1',
      lines: { 'cap-n': { voice: 'v-2' } },
    })
    expect(voiceSettingOf(modes, 'zh')).toEqual(DUB)
    expect(voiceKeyOf(null)).toBe(SOURCE_VOICES)
    expect(voiceModesAttribute({ [SOURCE_VOICES]: DUB })).toBe(
      '{"_source":{"mode":"dub","voice":null}}',
    )
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
