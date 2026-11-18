import { describe, expect, it } from 'vitest'
import { audio, caption, video } from '@/testing/final-cut'
import type { FilmClip } from './composition/film'
import {
  dubbingPlanOf,
  dubbingRequests,
  dubClips,
  dubsOf,
  dubsOverlapped,
  lineRefusals,
  narrationDubs,
  narrationRequests,
  shownIn,
  type DubbingRequest,
  type VoiceOfCaption,
} from './dubbing'
import { SOURCE_LOCALE } from './locales'

const A = 'https://media.test/videos/a.mp4'
const B = 'https://media.test/videos/b.mp4'

/** 素材 A 一段（0–4 秒）上四句、素材 B 一段（4–6 秒）上一句；第五句是手动加的，不属于片段。 */
const CLIPS: FilmClip[] = [
  video({ id: 'va', src: A, duration: 4_000 }),
  video({ id: 'vb', src: B, start: 4_000, duration: 2_000 }),
  caption({ id: 'c1', variable: 'v1', start: 0, duration: 500, owner: 'va' }),
  caption({ id: 'c2', variable: 'v2', start: 1_000, duration: 500, owner: 'va' }),
  caption({ id: 'c3', variable: 'v3', start: 2_000, duration: 500, owner: 'va' }),
  caption({ id: 'c4', variable: 'v4', start: 3_000, duration: 500, owner: 'va' }),
  caption({ id: 'c5', variable: 'v5', start: 4_500, duration: 500, owner: 'vb' }),
  caption({ id: 'c6', variable: 'v6', start: 6_500, duration: 500 }),
]
const VALUES = { v1: 'one', v2: 'two', v3: 'three', v4: 'four', v5: 'five', v6: 'six' }
const noLength = () => undefined
const everyLine: VoiceOfCaption = () => null

/** 各次请求按素材片、音色和配的字幕写成一行，方便比。 */
const shapeOf = (requests: readonly DubbingRequest[]) =>
  requests.map(({ src, voice, lines }) => ({
    src: src === A ? 'A' : 'B',
    voice,
    lines: lines.map(({ caption: id, startMs, slotEndMs }) => ({ id, startMs, slotEndMs })),
  }))

const plan = (voiceOf: VoiceOfCaption, picked?: (caption: string) => boolean) => {
  const result = dubbingRequests(CLIPS, VALUES, noLength, voiceOf, picked)
  if ('refusal' in result) throw new Error(result.refusal)
  return shapeOf(result.requests)
}

describe('配音请求：按句子挑、按素材片和音色分组', () => {
  it('同一条素材片两个音色各发一次；每句最晚占到这条素材片上下一句要配音的开始，最后一句不写', () => {
    const voiceOf: VoiceOfCaption = (id) => (id === 'c2' ? 'emma' : null)
    expect(plan(voiceOf)).toEqual([
      {
        src: 'A',
        voice: null,
        lines: [
          { id: 'c1', startMs: 0, slotEndMs: 1_000 },
          { id: 'c3', startMs: 2_000, slotEndMs: 3_000 },
          { id: 'c4', startMs: 3_000, slotEndMs: undefined },
        ],
      },
      { src: 'A', voice: 'emma', lines: [{ id: 'c2', startMs: 1_000, slotEndMs: 2_000 }] },
      { src: 'B', voice: null, lines: [{ id: 'c5', startMs: 500, slotEndMs: undefined }] },
    ])
  })

  it('不配音的句子不发，也不占位：前一句占到再下一句', () => {
    const voiceOf: VoiceOfCaption = (id) => (id === 'c2' ? undefined : null)
    expect(plan(voiceOf)[0]?.lines).toEqual([
      { id: 'c1', startMs: 0, slotEndMs: 2_000 },
      { id: 'c3', startMs: 2_000, slotEndMs: 3_000 },
      { id: 'c4', startMs: 3_000, slotEndMs: undefined },
    ])
  })

  it('只挑一句：只发这一句，上限照所有要配的句子算', () => {
    expect(plan(everyLine, (id) => id === 'c2')).toEqual([
      { src: 'A', voice: null, lines: [{ id: 'c2', startMs: 1_000, slotEndMs: 2_000 }] },
    ])
  })

  it('每次请求带着这条素材片的说话时段：它名下全部字幕（没翻的、不配音的、这次没挑的也算），同一条素材片各组一样', () => {
    const voiceOf: VoiceOfCaption = (id) => (id === 'c2' ? 'emma' : id === 'c4' ? undefined : null)
    const result = dubbingRequests(CLIPS, { ...VALUES, v3: '' }, noLength, voiceOf, (id) =>
      ['c2', 'c5'].includes(id),
    )
    if ('refusal' in result) throw new Error(result.refusal)
    const ofA = [
      { startMs: 0, endMs: 500 },
      { startMs: 1_000, endMs: 1_500 },
      { startMs: 2_000, endMs: 2_500 },
      { startMs: 3_000, endMs: 3_500 },
    ]
    expect(result.requests.map(({ src, voice, spans }) => ({ src, voice, spans }))).toEqual([
      { src: A, voice: 'emma', spans: ofA },
      { src: B, voice: null, spans: [{ startMs: 500, endMs: 1_000 }] },
    ])
    const both = dubbingRequests(CLIPS, VALUES, noLength, (id) => (id === 'c2' ? 'emma' : null))
    if ('refusal' in both) throw new Error(both.refusal)
    expect(both.requests.filter((request) => request.src === A).map(({ spans }) => spans)).toEqual([
      ofA,
      ofA,
    ])
  })

  it('同一段素材用在两个视频片段里时，说话时段重叠的并成一段', () => {
    const reused = [
      ...CLIPS,
      video({ id: 'vc', src: A, start: 7_000, duration: 1_000, mediaStart: 200 }),
      caption({ id: 'c7', variable: 'v1', start: 7_000, duration: 500, owner: 'vc' }),
    ]
    const result = dubbingRequests(reused, VALUES, noLength, everyLine, (id) => id === 'c1')
    if ('refusal' in result) throw new Error(result.refusal)
    expect(result.requests[0]?.spans.slice(0, 2)).toEqual([
      { startMs: 0, endMs: 700 },
      { startMs: 1_000, endMs: 1_500 },
    ])
  })

  it('一句都没挑中时请求是空的；一句都没翻时答复原因', () => {
    expect(plan(() => undefined)).toEqual([])
    expect(dubbingRequests(CLIPS, {}, noLength, everyLine)).toEqual({ refusal: 'untranslated' })
  })
})

describe('配好的配音建成配音片段', () => {
  const request: DubbingRequest = {
    src: A,
    voice: null,
    lines: [{ caption: 'c2', startMs: 1_000, endMs: 1_500, text: 'two', slotEndMs: 2_000 }],
    spans: [{ startMs: 1_000, endMs: 1_500 }],
  }

  it('只配一句时片段占到它的上限，不到音轨结尾', () => {
    expect(
      dubClips(CLIPS, request, { url: 'dub.m4a', durationMs: 4_000, lines: [] }).map(
        ({ caption: id, start, duration }) => ({ id, start, duration }),
      ),
    ).toEqual([{ id: 'c2', start: 1_000, duration: 1_000 }])
  })

  it('换掉的只是配好的那几句在这种语言下的配音片段', () => {
    const dub = (id: string, of: string, locale = 'en') =>
      audio({ id, dub: { locale, caption: of, trimmed: false, voice: null } })
    const clips = [...CLIPS, dub('d1', 'c1'), dub('d2', 'c2'), dub('d2-de', 'c2', 'de')]
    expect(dubsOf(clips, 'en', ['c2'])).toEqual(['d2'])
  })
})

/** 原文的旁白片段：配 `of` 这句，合成用的音色是 `voice`。 */
const narrationOf = (of: string, voice: string | null = 'v-own') =>
  audio({ id: `n-${of}`, dub: { locale: null, caption: of, trimmed: false, voice } })

/** 在 `CLIPS` 上加两句旁白：n1（3.6 秒，夹在素材 A 最后一句和素材 B 那句之间）和 n2（8 秒，最后一句）。 */
const NARRATED: FilmClip[] = [
  ...CLIPS,
  caption({ id: 'n1', variable: 'vn1', start: 3_600, duration: 300 }),
  caption({ id: 'n2', variable: 'vn2', start: 8_000, duration: 500 }),
  narrationOf('n1'),
  narrationOf('n2'),
]
const NARRATED_VALUES = { ...VALUES, vn1: 'narr one', vn2: 'narr two' }

describe('各语言下显示哪些配音片段', () => {
  const narration = narrationOf('n1')
  const english = audio({
    id: 'd',
    dub: { locale: 'en', caption: 'c1', trimmed: false, voice: null },
  })

  it('原文下显示旁白，不显示其它语言的配音', () => {
    expect([narration, english].filter(shownIn(SOURCE_LOCALE, 'original'))).toEqual([narration])
  })

  it('保留原声的语言下显示旁白', () => {
    expect([narration, english].filter(shownIn('en', 'original'))).toEqual([narration])
  })

  it('AI 配音的语言下只显示这种语言的配音，不显示旁白', () => {
    expect([narration, english].filter(shownIn('en', 'dub'))).toEqual([english])
  })
})

describe('旁白要配的句子', () => {
  const lines = (voiceOf: VoiceOfCaption, picked?: (caption: string) => boolean) =>
    narrationRequests(NARRATED, NARRATED_VALUES, voiceOf, picked).lines

  it('用这种语言的字；最晚占到它后面下一句要配音的字幕开始，最后一句不限', () => {
    expect(lines(everyLine)).toEqual([
      { caption: 'n1', text: 'narr one', voice: 'v-own', maxMs: 900 },
      { caption: 'n2', text: 'narr two', voice: 'v-own' },
    ])
  })

  it('音色：自己选的、跟着这种语言的按它，取到「原声」时用旁白记着的音色', () => {
    const voiceOf: VoiceOfCaption = (id) => (id === 'n1' ? 'emma' : null)
    expect(lines(voiceOf).map(({ caption: id, voice }) => ({ id, voice }))).toEqual([
      { id: 'n1', voice: 'emma' },
      { id: 'n2', voice: 'v-own' },
    ])
  })

  it('不配音的句子不配，也不占位', () => {
    const voiceOf: VoiceOfCaption = (id) => (id === 'c5' || id === 'n2' ? undefined : null)
    expect(lines(voiceOf)).toEqual([{ caption: 'n1', text: 'narr one', voice: 'v-own' }])
  })

  it('没翻的句子不配，也不占位', () => {
    const values = { ...NARRATED_VALUES, v5: '', vn2: '' }
    expect(narrationRequests(NARRATED, values, everyLine).lines).toEqual([
      { caption: 'n1', text: 'narr one', voice: 'v-own' },
    ])
  })

  it('只挑一句：只配这一句，上限照所有要配的句子算', () => {
    expect(lines(everyLine, (id) => id === 'n1')).toEqual([
      { caption: 'n1', text: 'narr one', voice: 'v-own', maxMs: 900 },
    ])
  })
})

describe('素材片的句子最晚占到时间线上后面那句旁白的开始', () => {
  /** 各素材片请求里各句的上限，按字幕编号。 */
  const slotEnds = (
    clips: readonly FilmClip[],
    values = NARRATED_VALUES,
    voiceOf: VoiceOfCaption = everyLine,
  ) => {
    const result = dubbingRequests(clips, values, noLength, voiceOf)
    if ('refusal' in result) throw new Error(result.refusal)
    return Object.fromEntries(
      result.requests.flatMap(({ lines }) => lines.map((line) => [line.caption, line.slotEndMs])),
    )
  }

  it('后面夹着一句要配音的旁白时，占到旁白字幕的开始；不比这条素材片上下一句晚', () => {
    // n1 在 3.6 秒，c4 是素材 A 最后一句、素材 A 的视频片段到 4 秒
    expect(slotEnds(NARRATED)).toMatchObject({ c3: 3_000, c4: 3_600, c5: undefined })
  })

  it('变速的片段：旁白的开始按入点和速度换算到素材片里', () => {
    const clips = [
      video({ id: 'vx', src: A, duration: 3_000, mediaStart: 500, playbackRate: 2 }),
      caption({ id: 'x1', variable: 'v1', start: 0, duration: 500, owner: 'vx' }),
      caption({ id: 'n1', variable: 'vn1', start: 1_000, duration: 500 }),
      narrationOf('n1'),
    ]
    expect(slotEnds(clips)).toEqual({ x1: 2_500 })
  })

  it('旁白没翻、选了不配音时不算', () => {
    expect(slotEnds(NARRATED, { ...NARRATED_VALUES, vn1: '' })).toMatchObject({ c4: undefined })
    expect(
      slotEnds(NARRATED, NARRATED_VALUES, (id) => (id === 'n1' ? undefined : null)),
    ).toMatchObject({ c4: undefined })
  })

  it('旁白在这句的视频片段结尾以后时不算', () => {
    // n2 在 8 秒，c5 所在的素材 B 的视频片段到 6 秒
    expect(slotEnds(NARRATED)).toMatchObject({ c5: undefined })
  })
})

describe('新配好的配音收短压住它的已有配音', () => {
  /** 语言 `locale` 配 `of` 这句的配音片段，`start`–`start + duration` 毫秒。 */
  const dub = (id: string, of: string, start: number, duration: number, locale = 'en') =>
    audio({ id, start, duration, dub: { locale, caption: of, trimmed: false, voice: null } })

  it('别的句子的配音压在新片段的开始上：收到新片段的开始、标成截了尾；没压住的不动', () => {
    const clips = [dub('d1', 'c1', 0, 2_000), dub('d3', 'c3', 2_500, 1_000)]
    expect(dubsOverlapped(clips, 'en', [{ caption: 'c2', start: 1_200 }])).toEqual(
      new Map([['d1', { duration: 1_200, trimmed: true }]]),
    )
  })

  it('只收掉取整误差那么一点（1 毫秒）：照样收短，不标截尾', () => {
    const clips = [dub('d1', 'c1', 400, 602)]
    expect(dubsOverlapped(clips, 'en', [{ caption: 'n1', start: 1_001 }])).toEqual(
      new Map([['d1', { duration: 601, trimmed: false }]]),
    )
  })

  it('同一句的、别的语言的不算', () => {
    const clips = [dub('d1', 'c1', 0, 2_000), dub('d1-de', 'c2', 0, 2_000, 'de')]
    expect(dubsOverlapped(clips, 'en', [{ caption: 'c1', start: 1_200 }])).toEqual(new Map())
  })

  it('原文的旁白只和原文的比', () => {
    // 旁白片段 n-n1 在 0–2 秒
    const clips = [narrationOf('n1'), dub('d1', 'c1', 0, 2_000)]
    expect(dubsOverlapped(clips, null, [{ caption: 'n2', start: 500 }])).toEqual(
      new Map([['n-n1', { duration: 500, trimmed: true }]]),
    )
  })

  it('收短后不到最短长度的不动', () => {
    const clips = [dub('d1', 'c1', 1_000, 2_000)]
    expect(dubsOverlapped(clips, 'en', [{ caption: 'c2', start: 1_050 }])).toEqual(new Map())
  })
})

describe('一种语言下的配音：素材片和旁白一起', () => {
  const onlyNarration = [
    caption({ id: 'n1', variable: 'vn1', start: 0, duration: 500 }),
    narrationOf('n1'),
  ]

  it('有视频片段和旁白：两种都在', () => {
    const plan = dubbingPlanOf(NARRATED, NARRATED_VALUES, noLength, everyLine)
    if ('refusal' in plan) throw new Error(plan.refusal)
    expect(plan.requests).toHaveLength(2)
    expect(plan.narrations.map((line) => line.caption)).toEqual(['n1', 'n2'])
  })

  it('没有视频片段、只有翻了的旁白：只配旁白', () => {
    expect(dubbingPlanOf(onlyNarration, { vn1: 'hi' }, noLength, everyLine)).toEqual({
      requests: [],
      narrations: [{ caption: 'n1', text: 'hi', voice: 'v-own' }],
    })
  })

  it('没有视频片段、旁白没翻：原因是没翻', () => {
    expect(dubbingPlanOf(onlyNarration, {}, noLength, everyLine)).toEqual({
      refusal: 'untranslated',
    })
  })

  it('没有视频片段也没有旁白：原因照素材片的', () => {
    expect(dubbingPlanOf([], {}, noLength, everyLine)).toEqual({ refusal: 'empty' })
  })
})

describe('其它语言给旁白配好的音建成配音片段', () => {
  const audioOf = (durationMs: number | null) => ({ url: 'n.m4a', durationMs, trimmed: false })

  it('和字幕对齐、从音频开头放，长度是音频的长度，有上限时不超过它', () => {
    expect(
      narrationDubs(NARRATED, [
        { line: { caption: 'n1', text: 'a', voice: 'v', maxMs: 900 }, audio: audioOf(950) },
        { line: { caption: 'n2', text: 'b', voice: 'v' }, audio: audioOf(1_800) },
      ]).map(({ caption: id, start, duration, mediaStart, src }) => ({
        id,
        start,
        duration,
        mediaStart,
        src,
      })),
    ).toEqual([
      { id: 'n1', start: 3_600, duration: 900, mediaStart: 0, src: 'n.m4a' },
      { id: 'n2', start: 8_000, duration: 1_800, mediaStart: 0, src: 'n.m4a' },
    ])
  })

  it('字幕已经不在了的不建', () => {
    expect(
      narrationDubs(CLIPS, [
        { line: { caption: 'n1', text: 'a', voice: 'v' }, audio: audioOf(1_000) },
      ]),
    ).toEqual([])
  })
})

describe('各句为什么配不了音', () => {
  it('有旁白的句子翻了就配得了，没翻的说没翻', () => {
    const values = { ...NARRATED_VALUES, vn2: '' }
    const refusals = lineRefusals(NARRATED, values, new Set(), () => true)
    expect(refusals.has('n1')).toBe(false)
    expect(refusals.get('n2')).toBe('untranslated')
  })

  it('不属于视频片段、还没翻、素材片对不上生成记录的句子各有原因；配得了的不在里面', () => {
    const values = { v1: 'one', v2: 'two', v3: 'three', v4: 'four', v6: 'six' }
    const dubbable = new Set(['c1', 'c2', 'c3', 'c4'])
    expect(lineRefusals(CLIPS, values, dubbable, (src) => src === A)).toEqual(
      new Map([
        ['c5', 'untranslated'],
        ['c6', 'unowned'],
      ]),
    )
    expect(lineRefusals(CLIPS, VALUES, new Set(['c1']), (src) => src === B)).toEqual(
      new Map([
        ['c2', 'untaken'],
        ['c3', 'untaken'],
        ['c4', 'untaken'],
        ['c5', 'crowded'],
        ['c6', 'unowned'],
      ]),
    )
  })
})
