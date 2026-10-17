import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import {
  EMPTY_FILM,
  insertSegment,
  sentenceKey,
  setSentenceText,
  trimSegment,
  type FilmState,
} from './film-draft'
import {
  burnedSubtitles,
  captionAt,
  latestSubtitles,
  projectSubtitles,
  subtitleSourceOf,
  type SubtitleSource,
} from './film-subtitles'

const A_SENTENCES = [
  { startMs: 500, endMs: 2000, text: '今天带来一款新耳机', speaker: 0 },
  { startMs: 2500, endMs: 4000, text: '单耳只有四克', speaker: 0 },
  { startMs: 6000, endMs: 8000, text: '现在下单，立减一百', speaker: 1 },
]
const READY_A: SubtitleSource = { kind: 'ready', jobId: 'sub-a', sentences: A_SENTENCES }

const build = (parts: readonly [string, string, number, number][]): FilmState =>
  parts.reduce(
    (state, [id, sourceJobId, start, end]) =>
      insertSegment(state, { sourceJobId, start, end }, state.segments.length, id) ?? state,
    EMPTY_FILM,
  )

const rows = (film: FilmState, sourceOf: (id: string) => SubtitleSource | undefined) =>
  projectSubtitles(film, sourceOf).subtitles.map((item) => [item.at, item.end, item.text])

describe('字幕记录', () => {
  it('每条成片取最新提交的那条字幕记录，别的种类不算', () => {
    const older = makeGenerationJob({
      id: 'old',
      kind: 'subtitle',
      sourceJobId: 'A',
      createdAt: '2026-09-01T10:00:00Z',
    })
    const newer = makeGenerationJob({
      id: 'new',
      kind: 'subtitle',
      sourceJobId: 'A',
      status: 'submitted',
      createdAt: '2026-09-01T11:00:00Z',
    })
    const video = makeGenerationJob({ id: 'v', sourceJobId: 'A' })

    expect(latestSubtitles([newer, video, older]).get('A')?.id).toBe('new')
  })

  it.each([
    ['没有字幕记录', undefined, 'missing'],
    [
      '在识别',
      makeGenerationJob({ kind: 'subtitle', status: 'pending', sentences: null }),
      'running',
    ],
    ['识别失败', makeGenerationJob({ kind: 'subtitle', status: 'failed' }), 'failed'],
    ['没有口播也是识别好了', makeGenerationJob({ kind: 'subtitle', sentences: [] }), 'ready'],
  ])('%s', (_, record, kind) => {
    expect(subtitleSourceOf(record).kind).toBe(kind)
  })
})

describe('字幕跟着画面走', () => {
  it('与段区间重叠的句子截到段内，换算到整片时间', () => {
    const film = build([
      ['s1', 'A', 1, 3],
      ['s2', 'A', 6, 7],
    ])

    expect(rows(film, () => READY_A)).toEqual([
      [0, 1, '今天带来一款新耳机'],
      [1.5, 2, '单耳只有四克'],
      [2, 3, '现在下单，立减一百'],
    ])
  })

  it('段裁剪后字幕跟着变', () => {
    const film = trimSegment(build([['s1', 'A', 1, 3]]), 's1', 'start', 2.2)

    expect(rows(film, () => READY_A)).toEqual([[0.3, 0.8, '单耳只有四克']])
  })

  it('没有口播什么也不显示、不标记；字幕记录还没读到时也不标', () => {
    const film = build([['s1', 'A', 0, 3]])
    const empty = projectSubtitles(film, () => ({ kind: 'ready', jobId: 'x', sentences: [] }))
    const unknown = projectSubtitles(film, () => undefined)

    expect([empty.subtitles, empty.statuses, unknown.subtitles, unknown.statuses]).toEqual([
      [],
      [],
      [],
      [],
    ])
  })

  it.each(['running', 'failed', 'missing'] as const)('来源%s时在该段范围内标出', (kind) => {
    const film = build([
      ['s1', 'A', 0, 2],
      ['s2', 'B', 0, 1.5],
    ])
    const { statuses } = projectSubtitles(film, (id) => (id === 'B' ? { kind } : READY_A))

    expect(statuses).toEqual([{ kind, segmentId: 's2', sourceJobId: 'B', at: 2, end: 3.5 }])
  })

  it('改过的字盖过识别结果，几段里出现的同一句一起改', () => {
    const film = setSentenceText(
      build([
        ['s1', 'A', 0, 1],
        ['s2', 'A', 1, 2],
      ]),
      sentenceKey('sub-a', 0),
      '改过的字',
    )

    expect(rows(film, () => READY_A)).toEqual([
      [0.5, 1, '改过的字'],
      [1, 2, '改过的字'],
    ])
  })

  it('烧进画面的字幕互不重叠：后开始的盖过先开始的，前一条在那一刻收住；空字不烧；预览显示的就是这一份', () => {
    const overlapping: SubtitleSource = {
      kind: 'ready',
      jobId: 'sub-c',
      sentences: [
        { startMs: 500, endMs: 2000, text: '今天带来一款新耳机' },
        { startMs: 1000, endMs: 2500, text: ' 插话 ' },
        { startMs: 2500, endMs: 4000, text: '单耳只有四克' },
      ],
    }
    const film = build([['s1', 'C', 0, 3]])
    const burned = burnedSubtitles(projectSubtitles(film, () => overlapping).subtitles)

    expect(burned).toEqual([
      { at: 0.5, end: 1, text: '今天带来一款新耳机' },
      { at: 1, end: 2.5, text: '插话' },
      { at: 2.5, end: 3, text: '单耳只有四克' },
    ])
    expect(captionAt(burned, 0.6)).toBe('今天带来一款新耳机')
    expect(captionAt(burned, 1.2)).toBe('插话')
    expect(captionAt(burned, 2.6)).toBe('单耳只有四克')
    expect(captionAt(burned, 3.1)).toBeUndefined()

    const blanked = setSentenceText(film, sentenceKey('sub-c', 1), '  ')
    expect(burnedSubtitles(projectSubtitles(blanked, () => overlapping).subtitles)).toEqual([
      { at: 0.5, end: 2, text: '今天带来一款新耳机' },
      { at: 2.5, end: 3, text: '单耳只有四克' },
    ])
  })
})
