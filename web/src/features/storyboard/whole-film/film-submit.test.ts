import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILM,
  insertSegment,
  sentenceKey,
  setSentenceText,
  setFont,
  setSegmentVolume,
  type FilmState,
} from './film-draft'
import {
  MUSIC_BED_GAIN,
  MUSIC_DUCKED_GAIN,
  musicGainCurve,
  speechSpansOf,
  type GainPoint,
} from './film-music'
import type { MusicStatus } from './film-music-status'
import { composeBlockedReason, wholeFilmBody, type ComposeReadiness } from './film-submit'
import { burnedSubtitles, projectSubtitles, type SubtitleSource } from './film-subtitles'

const CONVERSATION = 'conversation-1'
const TASK = 'task-1'

const SOURCES: Record<string, SubtitleSource> = {
  A: {
    kind: 'ready',
    jobId: 'sub-a',
    sentences: [
      { startMs: 500, endMs: 2000, text: '今天带来一款新耳机' },
      { startMs: 2500, endMs: 4000, text: '单耳只有四克' },
    ],
  },
  B: { kind: 'ready', jobId: 'sub-b', sentences: [] },
}

const build = (parts: readonly [string, string, number, number][]): FilmState =>
  parts.reduce(
    (state, [id, sourceJobId, start, end]) =>
      insertSegment(state, { sourceJobId, start, end }, state.segments.length, id) ?? state,
    EMPTY_FILM,
  )

const burnedOf = (film: FilmState) =>
  burnedSubtitles(projectSubtitles(film, (id) => SOURCES[id]).subtitles)

describe('合成提交体', () => {
  const cut = build([
    ['s1', 'B', 3, 5.5],
    ['s2', 'A', 1, 4],
  ])

  it('段取各自来源的原片起止；字幕是最终文字，时刻以第一段开头为 0，按时间排、不重叠', () => {
    const film = setSentenceText(cut, sentenceKey('sub-a', 0), '新耳机')

    expect(
      wholeFilmBody({
        conversationId: CONVERSATION,
        taskId: TASK,
        film,
        subtitles: burnedOf(film),
        music: null,
      }),
    ).toEqual({
      conversationId: CONVERSATION,
      taskId: TASK,
      segments: [
        { sourceJobId: 'B', startMs: 3000, endMs: 5500, volume: 1 },
        { sourceJobId: 'A', startMs: 1000, endMs: 4000, volume: 1 },
      ],
      subtitles: [
        { startMs: 2500, endMs: 3500, text: '新耳机' },
        { startMs: 4000, endMs: 5500, text: '单耳只有四克' },
      ],
    })
  })

  it('品牌字体提交资源 ID，恢复系统字体时不带字体字段', () => {
    const input = {
      conversationId: CONVERSATION,
      taskId: TASK,
      film: cut,
      subtitles: burnedOf(cut),
      music: null,
    }
    expect(
      wholeFilmBody({
        ...input,
        film: setFont(cut, {
          fontId: 'font',
          name: '品牌字体',
          url: 'https://example.com/font.ttf',
        }),
      }).fontId,
    ).toBe('font')
    expect(wholeFilmBody({ ...input, film: setFont(cut, null) })).not.toHaveProperty('fontId')
  })

  it('有音乐时带音频记录、起点（毫秒）与口播处压低的曲线，曲线不含结尾淡出', () => {
    const subtitles = projectSubtitles(cut, (id) => SOURCES[id]).subtitles
    const curve = musicGainCurve(speechSpansOf(subtitles), 5.5)
    const body = wholeFilmBody({
      conversationId: CONVERSATION,
      taskId: null,
      film: cut,
      subtitles: burnedSubtitles(subtitles),
      music: { audioJobId: 'music-1', start: 12.0005, curve },
    })

    expect(body.taskId).toBeNull()
    expect(body.music?.audioJobId).toBe('music-1')
    expect(body.music?.offsetMs).toBe(12_001)
    expect(body.music?.gain).toEqual(curve)
    expect(body.music?.volume).toBe(1)
    expect(body.music?.gain[0]).toEqual({ atMs: 0, gain: MUSIC_BED_GAIN })
    expect(body.music?.gain.at(-1)).toEqual({ atMs: 5500, gain: MUSIC_DUCKED_GAIN })
  })

  it('段音量与音乐音量分别提交，不乘进自动压低曲线', () => {
    const curve = [{ atMs: 0, gain: MUSIC_DUCKED_GAIN }]
    const body = wholeFilmBody({
      conversationId: CONVERSATION,
      taskId: TASK,
      film: setSegmentVolume(cut, 's1', 0),
      subtitles: [],
      music: { audioJobId: 'music', start: 0.25, curve, volume: 2 },
    })
    expect(body.segments.map((segment) => segment.volume)).toEqual([0, 1])
    expect(body.music).toMatchObject({ offsetMs: 250, volume: 2, gain: curve })
  })
})

const readyMusic = (curve: GainPoint[]): MusicStatus => ({
  kind: 'ready',
  title: '生成的音乐',
  song: { duration: 30, grid: null },
  peaks: { rate: 50, peaks: [] },
  placement: { start: 0, userPlaced: false, available: 30, shortBy: 0, onBeat: [], cutCount: 1 },
  previewCurve: curve,
  plan: { audioJobId: 'm', start: 0, curve },
})

const READY: ComposeReadiness = {
  submitting: false,
  segmentCount: 2,
  totalSeconds: 5,
  task: 'ready',
  subtitleRecords: 'ready',
  recognizing: 0,
  music: { kind: 'none' },
  subtitles: [{ text: '一句' }],
}

describe('「合成成片」不能点的原因', () => {
  it('都齐了就能合成；识别失败、没有识别记录的段不挡（recognizing 只数还在识别的）', () => {
    expect(composeBlockedReason(READY)).toBeUndefined()
    expect(composeBlockedReason({ ...READY, music: readyMusic([]) })).toBeUndefined()
  })

  it.each<[string, Partial<ComposeReadiness>, string]>([
    ['提交中', { submitting: true, segmentCount: 0 }, '正在提交合成，请稍候'],
    ['成片轨为空', { segmentCount: 0 }, '成片轨为空，无法合成；请先从素材轨挑段放入成片轨'],
    ['需求单在读', { task: 'loading' }, '任务信息读取中，暂时无法合成'],
    ['需求单读失败', { task: 'failed' }, '任务信息读取失败，无法合成；请点击「重试」'],
    ['字体不可用', { fontBlocked: '字体缺字' }, '字体缺字'],
    ['字幕记录在读', { subtitleRecords: 'loading' }, '字幕读取中，暂时无法合成'],
    ['字幕记录读失败', { subtitleRecords: 'failed' }, '字幕读取失败，无法合成；请点击「重试」'],
    ['有段在识别', { recognizing: 2 }, '有 2 段的字幕正在识别，暂时无法合成；识别完成后即可合成'],
    ['音乐在读', { music: { kind: 'reading' } }, '音乐读取中，暂时无法合成'],
    [
      '字幕超过 200 字',
      { subtitles: [{ text: '短' }, { text: '长'.repeat(201) }] },
      '第 2 条字幕超过 200 字，无法合成；请删减文字',
    ],
  ])('%s', (_, patch, reason) => {
    expect(composeBlockedReason({ ...READY, ...patch })).toBe(reason)
  })
  it.each([
    [{ segmentCount: 101 }, '片段超过 100 段'],
    [{ totalSeconds: 120.001 }, '整片含片头片尾超过 120 秒'],
    [{ submittedSubtitleCount: 501 }, '字幕超过 500 条'],
    [
      { music: readyMusic(Array.from({ length: 501 }, (_, atMs) => ({ atMs, gain: 1 }))) },
      '音乐音量变化超过 500 个点',
    ],
  ] satisfies [Partial<ComposeReadiness>, string][])(
    '拒绝超过合同上限的合成 %j',
    (patch, reason) => {
      expect(composeBlockedReason({ ...READY, ...patch })).toContain(reason)
    },
  )
})
