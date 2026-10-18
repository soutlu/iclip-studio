import { describe, expect, it } from 'vitest'
import { card, contextOf, draftOf, expectOk, sentence, source, video } from '@/testing/whole-film'
import { undo, redo, startHistory } from '../../editing/edit-history'
import { autoBeatSync } from './beat-sync'
import type { MusicBeat } from './context'
import type { WholeFilmDraft } from './draft'
import { commitEdit } from './history'
import { cutsOf, filmDuration } from './timeline'

const beatsEvery = (gapMs: number, count: number): MusicBeat[] =>
  Array.from({ length: count }, (_, k) => ({ timeMs: k * gapMs, strong: k % 4 === 0 }))

const music = { jobId: 'm1', offset: 0, volume: 1 }

const cutTimes = (draft: WholeFilmDraft) => cutsOf(draft).map((c) => c.timeMs)

const onBeat = (draft: WholeFilmDraft, beats: MusicBeat[]) =>
  cutTimes(draft).filter((t) => beats.some((b) => Math.abs(b.timeMs - t) <= 10)).length

describe('autoBeatSync：每 500 毫秒一拍、每四拍一个强拍', () => {
  const beats = beatsEvery(500, 61)
  const context = contextOf(
    {
      A: source(20_000),
      // 2.1 秒出点前后是一句口播：往前挪会截掉它
      B: source(20_000, [sentence(1_950, 2_500)]),
      // 素材只有 1.8 秒：出点之后没有画面
      C: source(1_800),
    },
    { m1: { durationMs: 30_000, beats } },
  )
  /** 切点：2000（片头结束，本来就在拍上）、4300、6400、8200 */
  const film = () =>
    draftOf(
      [
        card('c1', 'intro', 2_000),
        video('v1', 'A', 1_000, 2_300),
        video('v2', 'B', 0, 2_100),
        video('v3', 'C', 0, 1_800),
        video('v4', 'A', 5_000, 1_000),
      ],
      { music },
    )

  it('挪了的 + 保留的 + 原本在拍上的 = 切点数；原本在拍上的两边都不算', () => {
    const before = film()
    const { draft, moved, kept } = expectOk(autoBeatSync(before, context))
    expect({ moved, kept }).toEqual({ moved: 2, kept: 1 })
    expect(moved + kept + onBeat(before, beats)).toBe(cutTimes(draft).length)
    expect(onBeat(draft, beats)).toBe(moved + onBeat(before, beats))
  })

  it('强拍优先：4300 离 4500 更近，仍挪到强拍 4000；后面的段跟着移', () => {
    const { draft } = expectOk(autoBeatSync(film(), context))
    expect(cutTimes(draft)).toEqual([2_000, 4_000, 6_100, 7_500])
    expect(draft.layer0[1]).toMatchObject({ duration: 2_000, playbackStart: 1_000 })
  })

  it('会截掉口播的切点不动；最近的拍在后面但出点后没有画面，改挪到前一拍', () => {
    const { draft } = expectOk(autoBeatSync(film(), context))
    expect(draft.layer0[2]).toMatchObject({ duration: 2_100, playbackStart: 0 })
    expect(draft.layer0[3]).toMatchObject({ duration: 1_400, playbackStart: 0 })
  })

  it('音乐不动，每段仍在素材范围内', () => {
    const { draft } = expectOk(autoBeatSync(film(), context))
    expect(draft.music).toEqual(music)
    for (const clip of draft.layer0) {
      if (clip.type !== 'video') continue
      const media = context.sources[clip.sourceJobId]
      expect(clip.playbackStart).toBeGreaterThanOrEqual(0)
      expect(clip.playbackStart + clip.duration).toBeLessThanOrEqual(media?.durationMs ?? 0)
      expect(clip.duration).toBeGreaterThanOrEqual(100)
    }
  })

  it('一步撤销，可以重做', () => {
    const before = film()
    const synced = commitEdit(startHistory(before), autoBeatSync(before, context))
    expect(synced.past).toHaveLength(1)
    expect(undo(synced).present).toEqual(before)
    expect(redo(undo(synced)).present).toEqual(synced.present)
  })

  it('最近的拍在后面且出点之后有画面：往后挪', () => {
    const later = draftOf([video('v1', 'A', 0, 4_400), video('v2', 'A', 0, 1_000)], { music })
    const { draft, moved } = expectOk(autoBeatSync(later, context))
    expect(moved).toBe(1)
    expect(cutTimes(draft)).toEqual([4_500])
  })

  it('往后挪时新出点落在句子中间，或切点原本就在句子中间：不挪', () => {
    const speech = contextOf(
      {
        intoSentence: source(20_000, [sentence(4_450, 5_000)]),
        alreadyInside: source(20_000, [sentence(4_300, 4_420)]),
      },
      { m1: { durationMs: 30_000, beats } },
    )
    for (const sourceJobId of ['intoSentence', 'alreadyInside']) {
      const clips = [video('v1', sourceJobId, 0, 4_400), video('v2', sourceJobId, 0, 1_000)]
      const later = draftOf(clips, { music })
      expect(expectOk(autoBeatSync(later, speech))).toMatchObject({
        moved: 0,
        kept: 1,
        draft: later,
      })
    }
  })

  it('挪了会让前面的转场放不下的切点保持原样，其余照挪', () => {
    // 片头后的转场从 1000 开始铺 3.2 秒，v1 缩到 3 秒就放不下
    const withTransition = contextOf(
      { A: source(20_000) },
      { m1: { durationMs: 30_000, beats } },
      { long: { cutAt: 0, durationMs: 3_200 } },
    )
    const before = draftOf(
      [
        video('v0', 'A', 0, 1_000),
        video('v1', 'A', 0, 3_300),
        video('v2', 'A', 0, 1_000),
        video('v3', 'A', 0, 1_000),
      ],
      {
        music,
        transitions: [
          { id: 't1', afterClipId: 'v0', component: 'long', duration: 3_200, variables: {} },
        ],
      },
    )
    const { draft, moved, kept } = expectOk(autoBeatSync(before, withTransition))
    expect({ moved, kept }).toEqual({ moved: 1, kept: 1 })
    expect(cutTimes(draft)).toEqual([1_000, 4_300, 5_500])
    expect(draft.transitions).toEqual(before.transitions)
  })

  it('音乐起点平移拍点', () => {
    const shifted = draftOf([video('v1', 'A', 0, 4_400), video('v2', 'A', 0, 1_000)], {
      music: { ...music, offset: 250 },
    })
    expect(cutTimes(expectOk(autoBeatSync(shifted, context)).draft)).toEqual([4_250])
  })

  it('没有音乐、没有拍点：拒绝', () => {
    expect(autoBeatSync(draftOf([video('v1', 'A', 0, 1_000)]), context)).toEqual({
      ok: false,
      refusal: 'no-music',
    })
    const noBeats = contextOf({ A: source(20_000) }, { m1: { durationMs: 30_000 } })
    expect(autoBeatSync(film(), noBeats)).toEqual({ ok: false, refusal: 'no-beats' })
  })
})

describe('autoBeatSync：设计稿 QA 的两个数值用例', () => {
  // 设计稿示例音乐的拍点（秒 × 1000），每四拍一个强拍
  const beats = [186, 789, 1_393, 1_997, 2_601, 3_204, 3_808, 4_412, 5_016, 5_619].map(
    (timeMs, k) => ({ timeMs, strong: k % 4 === 0 }),
  )
  const context = contextOf(
    { clip1: source(13_056), clip3: source(13_056) },
    { m1: { durationMs: 29_950, beats } },
  )

  it('最近的拍在后面但没有画面：改挪到上一拍 1.393 秒', () => {
    const draft = draftOf([video('v1', 'clip1', 11_167, 1_889), video('v2', 'clip3', 0, 1_375)], {
      music,
    })
    const result = expectOk(autoBeatSync(draft, context))
    expect({ moved: result.moved, kept: result.kept }).toEqual({ moved: 1, kept: 0 })
    expect(cutTimes(result.draft)).toEqual([1_393])
    expect(filmDuration(result.draft)).toBe(1_393 + 1_375)
  })

  it('第一段只剩 0.15 秒且已到素材末尾，前面又没有拍：保持原样', () => {
    const draft = draftOf([video('v1', 'clip1', 12_906, 150), video('v2', 'clip3', 0, 1_375)], {
      music,
    })
    expect(expectOk(autoBeatSync(draft, context))).toMatchObject({ moved: 0, kept: 1, draft })
  })
})
