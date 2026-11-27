import { describe, expect, it } from 'vitest'
import { audio, caption, video } from '@/testing/final-cut'
import type { AudioDub, FilmClip } from './composition/film'
import { SOURCE_VOICES, type VoiceModes, type VoiceSetting } from './composition/voices'
import { SOURCE_SHOWN, type ShownLocale } from './locales'
import {
  lineStates,
  speedText,
  voiceSummary,
  voicingOf,
  type LineState,
  type Voicing,
} from './voice-lines'

const take = video({ id: 'va', src: 'https://media.test/a.mp4', duration: 4_000 })
// c1 属于视频片段；n 是有旁白片段（记着音色 v-own）的旁白句；m 是手动加的、还没有旁白片段的旁白句
const c1 = caption({ id: 'c1', variable: 'v1', start: 0, duration: 500, owner: 'va', text: '一' })
const n = caption({ id: 'n', variable: 'vn', start: 1_000, duration: 500, text: '旁白' })
const m = caption({ id: 'm', variable: 'vm', start: 2_000, duration: 500, text: '新的' })

const dubOf = (
  locale: string | null,
  of: string,
  record: Partial<Pick<AudioDub, 'text' | 'voice' | 'speed' | 'trimmed'>> = {},
) =>
  audio({
    id: `d-${locale ?? 'src'}-${of}`,
    dub: { locale, caption: of, trimmed: false, text: null, voice: null, speed: 1, ...record },
  })

const narration = dubOf(null, 'n', { voice: 'v-own' })
const CLIPS: FilmClip[] = [take, c1, n, m, narration]
const EN: ShownLocale = { code: 'en', values: { v1: 'one', vn: 'narr', vm: 'new' } }

const setting = (patch: Partial<VoiceSetting> = {}): VoiceSetting => ({
  mode: 'dub',
  voice: null,
  lines: {},
  ...patch,
})

/** 三句在 `modes` 下、语言 `shown` 下的人声，按 c1、n、m。 */
const voices = (modes: VoiceModes, shown: ShownLocale = EN) => {
  const voicing = voicingOf(CLIPS, modes, shown)
  return [c1, n, m].map((each) => voicing.voice(each))
}

const ORIGINAL = { kind: 'original' }
const voiced = (voice: string | null) => ({ kind: 'voiced', voice })
const VOICELESS = { kind: 'voiceless' }

describe('每句怎么配（voicingOf）', () => {
  it('原文原声：视频句保留原声；旁白句只用自己的音色（原文下给它选的，没选时旁白片段记着的），都没有时还没有音色', () => {
    expect(voices({}, SOURCE_SHOWN)).toEqual([ORIGINAL, voiced('v-own'), VOICELESS])
    // 原声时默认音色不管用，只看自己选的
    const chosen = {
      [SOURCE_VOICES]: setting({ mode: 'original', voice: 'v-d', lines: { m: { voice: 'emma' } } }),
    }
    expect(voices(chosen, SOURCE_SHOWN)).toEqual([ORIGINAL, voiced('v-own'), voiced('emma')])
    const muted = { [SOURCE_VOICES]: setting({ mode: 'original', lines: { n: { dub: false } } }) }
    expect(voices(muted, SOURCE_SHOWN)[1]).toEqual({ kind: 'unvoiced' })
  })

  it('原文配音：视频句跟着默认音色（原声的音色是从素材片取），旁白句取到原声的音色时用自己的音色', () => {
    expect(voices({ [SOURCE_VOICES]: setting() }, SOURCE_SHOWN)).toEqual([
      voiced(null),
      voiced('v-own'),
      VOICELESS,
    ])
    expect(voices({ [SOURCE_VOICES]: setting({ voice: 'v-d' }) }, SOURCE_SHOWN)).toEqual([
      voiced('v-d'),
      voiced('v-d'),
      voiced('v-d'),
    ])
  })

  it('外语原声：每句都保留原声（放的是原文的声音）', () => {
    expect(voices({ en: setting({ mode: 'original', voice: 'v-d' }) })).toEqual([
      ORIGINAL,
      ORIGINAL,
      ORIGINAL,
    ])
  })

  it('外语配音：视频句跟着这种语言的音色；旁白句取到原声的音色时用它原文下的音色（原文下选的，或旁白片段记着的）', () => {
    expect(voices({ en: setting() })).toEqual([voiced(null), voiced('v-own'), VOICELESS])
    const sourceChoice = {
      en: setting(),
      [SOURCE_VOICES]: setting({ mode: 'original', lines: { m: { voice: 'emma' } } }),
    }
    expect(voices(sourceChoice)).toEqual([voiced(null), voiced('v-own'), voiced('emma')])
    expect(voices({ en: setting({ voice: 'v-d', lines: { c1: { dub: false } } }) })).toEqual([
      { kind: 'unvoiced' },
      voiced('v-d'),
      voiced('v-d'),
    ])
  })

  it('念的字：原文是字幕的字，外语是译文（没翻是空串），去掉两头空白', () => {
    expect(voicingOf(CLIPS, {}, SOURCE_SHOWN).text(n)).toBe('旁白')
    const shown: ShownLocale = { code: 'en', values: { v1: '  one ' } }
    expect([c1, n].map(voicingOf(CLIPS, {}, shown).text)).toEqual(['one', ''])
  })
})

describe('各句的样子（lineStates）', () => {
  const statesOf = ({
    clips = CLIPS,
    modes = { en: setting() },
    shown = EN,
    running = new Set<string>(),
    refusal = () => undefined,
    busy,
  }: {
    clips?: FilmClip[]
    modes?: VoiceModes
    shown?: ShownLocale
    running?: ReadonlySet<string>
    refusal?: (caption: string) => string | undefined
    busy?: string
  } = {}) => {
    const voicing: Voicing = voicingOf(clips, modes, shown)
    return lineStates({
      clips,
      locale: shown.code,
      voicing,
      lines: (modes[shown.code ?? SOURCE_VOICES] ?? setting()).lines,
      running,
      refusal,
      busy,
    })
  }
  const statusOf = (states: ReadonlyMap<string, LineState>) =>
    Object.fromEntries([...states].map(([id, state]) => [id, state.status]))

  it('还没配、正在合成、不配音、还没有音色；配了且记录对得上是已配好', () => {
    const englishDub = dubOf('en', 'c1', { text: 'one', voice: null, speed: 1.18 })
    expect(statusOf(statesOf({ clips: [...CLIPS, englishDub] }))).toEqual({
      c1: 'ready',
      n: 'missing',
      m: 'voiceless',
    })
    expect(statusOf(statesOf({ running: new Set(['c1', 'n']) }))).toMatchObject({
      c1: 'running',
      n: 'running',
    })
    const states = statesOf({ modes: { en: setting({ lines: { n: { dub: false } } }) } })
    expect(states.get('n')).toMatchObject({ status: 'unvoiced', own: { dub: false } })
    expect(states.get('m')?.blocked).toBe('该条字幕还没有可用的音色，请先选择音色')
  })

  it('过期：记着的字和现在的字不一样、记着的音色和现在要用的不一样；改回去就不过期', () => {
    const englishDub = dubOf('en', 'c1', { text: 'one', voice: null })
    const clips = [...CLIPS, englishDub]
    const edited: ShownLocale = { code: 'en', values: { ...EN.values, v1: 'one more' } }
    expect(statesOf({ clips, shown: edited }).get('c1')?.status).toBe('stale')
    expect(statesOf({ clips, shown: EN }).get('c1')?.status).toBe('ready')
    const otherVoice = { en: setting({ lines: { c1: { voice: 'emma' } } }) }
    expect(statesOf({ clips, modes: otherVoice }).get('c1')).toMatchObject({
      status: 'stale',
      own: { voice: 'emma' },
      voice: 'emma',
    })
    expect(statesOf({ clips, modes: { en: setting() } }).get('c1')?.status).toBe('ready')
  })

  it('旁白句的配音记着它用的库音色：旁白自己的音色换了，外语里取原声音色的那句跟着过期', () => {
    const englishNarration = dubOf('en', 'n', { text: 'narr', voice: 'v-own' })
    const clips = [...CLIPS, englishNarration]
    expect(statesOf({ clips }).get('n')?.status).toBe('ready')
    const renamed = {
      en: setting(),
      [SOURCE_VOICES]: setting({ mode: 'original', lines: { n: { voice: 'emma' } } }),
    }
    expect(statesOf({ clips, modes: renamed }).get('n')?.status).toBe('stale')
  })

  it('没有记录的老配音片段一律不过期', () => {
    const legacy = dubOf('en', 'c1')
    const edited: ShownLocale = { code: 'en', values: { ...EN.values, v1: 'changed' } }
    expect(statesOf({ clips: [...CLIPS, legacy], shown: edited }).get('c1')?.status).toBe('ready')
  })

  it('保留原声的句子不能选音色、不能合成；配不了的原因和在合成别的都挡住合成', () => {
    const original = statesOf({ modes: { en: setting({ mode: 'original' }) } }).get('c1')
    expect(original).toMatchObject({ status: 'original' })
    expect(original?.chooseBlocked).toBeDefined()
    expect(original?.blocked).toBeDefined()
    const refused = statesOf({ refusal: (id) => (id === 'c1' ? '没翻' : undefined) })
    expect(refused.get('c1')).toMatchObject({ status: 'missing', blocked: '没翻' })
    expect(refused.get('c1')?.chooseBlocked).toBeUndefined()
    const busy = statesOf({ busy: '在合成' })
    expect(busy.get('n')?.blocked).toBe('在合成')
    // 在合成别的只挡住现在发起：照样是待处理的
    expect(busy.get('n')?.pending).toBe(true)
    expect(voiceSummary(CLIPS, 'en', busy, 0).pending).toBe(2)
  })

  it('已有配音的倍数和截没截尾；没配音时是 null、false', () => {
    const dub = dubOf('en', 'c1', { text: 'one', speed: 1.18, trimmed: true })
    const states = statesOf({ clips: [...CLIPS, dub] })
    expect(states.get('c1')).toMatchObject({ speed: 1.18, trimmed: true })
    expect(states.get('n')).toMatchObject({ speed: null, trimmed: false })
  })

  it('汇总：待处理是还没配的和过期的、合成得了的；有没有配音看这种语言的配音片段', () => {
    const clips = [...CLIPS, dubOf('en', 'c1', { text: 'old', voice: null })]
    const states = statesOf({ clips })
    expect(voiceSummary(clips, 'en', states, 2)).toEqual({ dubbed: true, pending: 2, running: 2 })
    const blocked = statesOf({ clips, refusal: (id) => (id === 'n' ? '没翻' : undefined) })
    expect(voiceSummary(clips, 'en', blocked, 0)).toEqual({ dubbed: true, pending: 1, running: 0 })
    expect(
      voiceSummary(CLIPS, 'de', statesOf({ shown: { code: 'de', values: {} } }), 0).dubbed,
    ).toBe(false)
  })
})

describe('倍速写法', () => {
  it('加速了写倍数（两位小数，去掉末尾的 0）；截了尾写「倍速 · 截尾」；没加速、四舍五入是 1 的不写', () => {
    expect(speedText(1.183, false)).toBe('1.18×')
    expect(speedText(1.2, false)).toBe('1.2×')
    expect(speedText(1.25, true)).toBe('倍速 · 截尾')
    expect(speedText(1, false)).toBeUndefined()
    expect(speedText(1.004, false)).toBeUndefined()
  })
})
