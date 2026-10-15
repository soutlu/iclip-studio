import { describe, expect, it } from 'vitest'
import {
  addManualSubtitle,
  EMPTY_FILM,
  insertSegment,
  sentenceKey,
  setManualText,
  setSentenceText,
  type FilmState,
} from './film-draft'
import { MUSIC_BED_GAIN, MUSIC_DUCKED_GAIN, musicGainCurve, speechSpansOf } from './film-music'
import { composeBlockedReason, wholeFilmBody, type ComposeReadiness } from './film-submit'
import { burnedSubtitles, projectSubtitles, type SubtitleSource } from './film-subtitles'

const CONVERSATION = 'conversation-1'
const TASK = 'task-1'

/** 成片 A 的口播：0.5–2 秒、2.5–4 秒两句；成片 B 没有口播。 */
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
  // 第 1 段：B 的 3–5.5 秒（整片 0–2.5）；第 2 段：A 的 1–4 秒（整片 2.5–5.5）。
  const cut = build([
    ['s1', 'B', 3, 5.5],
    ['s2', 'A', 1, 4],
  ])

  it('段取各自来源的原片起止；字幕是最终文字，时刻以第一段开头为 0，按时间排、不重叠', () => {
    // 改第一句的字，在整片 3 秒处（第 2 段里）加一条手动字幕，再加一条空的手动字幕。
    const film = setManualText(
      addManualSubtitle(
        addManualSubtitle(setSentenceText(cut, sentenceKey('sub-a', 0), '新耳机'), 3, 'm1') ?? cut,
        0.4,
        'm2',
      ) ?? cut,
      'm1',
      '手动加的',
    )

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
        { sourceJobId: 'B', startMs: 3000, endMs: 5500 },
        { sourceJobId: 'A', startMs: 1000, endMs: 4000 },
      ],
      // 第一句从段头 1 秒起（整片 2.5 秒），被 3 秒处的手动字幕截住；手动字幕被第二句（A 的 2.5 秒，整片 4 秒）截住。
      subtitles: [
        { startMs: 2500, endMs: 3000, text: '新耳机' },
        { startMs: 3000, endMs: 4000, text: '手动加的' },
        { startMs: 4000, endMs: 5500, text: '单耳只有四克' },
      ],
    })
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
    // 整片时间上：口播 2.5–5.5 秒压低，到结尾仍是压低的音量，没有淡到 0。
    expect(body.music?.gain[0]).toEqual({ atMs: 0, gain: MUSIC_BED_GAIN })
    expect(body.music?.gain.at(-1)).toEqual({ atMs: 5500, gain: MUSIC_DUCKED_GAIN })
  })
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
    expect(
      composeBlockedReason({
        ...READY,
        music: { kind: 'ready', plan: { audioJobId: 'm', start: 0, curve: [] } },
      }),
    ).toBeUndefined()
  })

  it.each<[string, Partial<ComposeReadiness>, string]>([
    ['提交中', { submitting: true, segmentCount: 0 }, '正在提交合成，请稍候'],
    ['成片轨为空', { segmentCount: 0 }, '成片轨为空，无法合成；请先从素材轨挑段放入成片轨'],
    ['需求单在读', { task: 'loading' }, '任务信息读取中，暂时无法合成'],
    ['需求单读失败', { task: 'failed' }, '任务信息读取失败，无法合成；请点击「重试」'],
    ['字幕记录在读', { subtitleRecords: 'loading' }, '字幕读取中，暂时无法合成'],
    ['字幕记录读失败', { subtitleRecords: 'failed' }, '字幕读取失败，无法合成；请点击「重试」'],
    ['有段在识别', { recognizing: 2 }, '有 2 段的字幕正在识别，暂时无法合成；识别完成后即可合成'],
    ['音乐在上传', { music: { kind: 'uploading' } }, '音乐上传中，暂时无法合成'],
    ['音乐在生成', { music: { kind: 'generating' } }, '音乐生成中，暂时无法合成'],
    ['音乐在读', { music: { kind: 'reading' } }, '音乐读取中，暂时无法合成'],
    ['音乐不可用', { music: { kind: 'failed' } }, '音乐不可用，无法合成；请重试、换一首或删除音乐'],
    [
      '音乐比成片短',
      { music: { kind: 'short', shortBy: 4 } },
      '音乐比成片短 4.0 秒，无法合成；请重新生成或换一首',
    ],
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
      {
        music: {
          kind: 'ready',
          plan: {
            audioJobId: 'm',
            start: 0,
            curve: Array.from({ length: 501 }, (_, atMs) => ({ atMs, gain: 1 })),
          },
        },
      },
      '音乐音量变化超过 500 个点',
    ],
  ] satisfies [Partial<ComposeReadiness>, string][])(
    '拒绝超过合同上限的合成 %j',
    (patch, reason) => {
      expect(composeBlockedReason({ ...READY, ...patch })).toContain(reason)
    },
  )
})
