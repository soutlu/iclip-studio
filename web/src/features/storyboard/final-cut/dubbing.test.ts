import { describe, expect, it } from 'vitest'
import { audio, caption, video } from '@/testing/final-cut'
import type { FilmClip } from './composition/film'
import {
  dubbingRequests,
  dubClips,
  dubsOf,
  lineRefusals,
  type DubbingRequest,
  type VoiceOfCaption,
} from './dubbing'

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
      audio({ id, dub: { locale, caption: of, trimmed: false } })
    const clips = [...CLIPS, dub('d1', 'c1'), dub('d2', 'c2'), dub('d2-de', 'c2', 'de')]
    expect(dubsOf(clips, 'en', ['c2'])).toEqual(['d2'])
  })
})

describe('各句为什么配不了音', () => {
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
