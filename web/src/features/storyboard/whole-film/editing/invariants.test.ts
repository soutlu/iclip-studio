import { expect, it } from 'vitest'
import { contextOf, draftOf, FADE, sentence, source } from '@/testing/whole-film'
import { redo, startHistory, undo, type History } from '../../editing/edit-history'
import { transitionWindow } from '../composition/build'
import { autoBeatSync } from './beat-sync'
import { clearCaptionText, setCaptionText } from './captions'
import {
  MAX_FILM_MS,
  MAX_VIDEO_CLIPS,
  MAX_VOLUME,
  MIN_CLIP_MS,
  type EndCardRole,
  type WholeFilmDraft,
} from './draft'
import { addEndCard, replaceEndCardComponent } from './end-cards'
import { commitEdit } from './history'
import { deleteClip, insertMaterial, moveClip, setClipVolume, splitClip, trimClip } from './layer0'
import { setMusic, setMusicOffset } from './music'
import { addOverlay, moveOverlay, removeOverlay, trimOverlay } from './overlays'
import type { EditResult } from './result'
import { filmDuration } from './timeline'
import { removeTransition, setTransition } from './transitions'

const context = contextOf(
  {
    a: source(20_000, [sentence(1_000, 2_500), sentence(6_000, 9_000), sentence(12_000, 12_400)]),
    b: source(8_000),
    c: source(1_500, [sentence(200, 1_400)]),
    big: source(60_000),
  },
  {
    m1: {
      durationMs: 40_000,
      beats: Array.from({ length: 80 }, (_, k) => ({ timeMs: 120 + k * 480, strong: k % 4 === 0 })),
    },
    m2: { durationMs: 5_000, beats: [{ timeMs: 0, strong: true }] },
  },
  { fade: FADE, wipe: { cutAt: 0, durationMs: 1_200 } },
)

/** 固定种子的伪随机数（mulberry32），同一种子每次得到同一串操作 */
const randomOf = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const violations = (draft: WholeFilmDraft): string[] => {
  const found: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) found.push(message)
  }
  const total = filmDuration(draft)
  const ints = [
    ...draft.layer0.flatMap((c) => [
      c.start,
      c.duration,
      ...(c.type === 'video' ? [c.playbackStart] : []),
    ]),
    ...draft.transitions.map((t) => t.duration),
    ...draft.overlays.flatMap((o) => [o.start, o.duration]),
    ...(draft.music ? [draft.music.offset] : []),
  ]
  check(ints.every(Number.isInteger), '时间都是整数毫秒')
  check(total <= MAX_FILM_MS, '整片不超过 120 秒')
  const videos = draft.layer0.filter((c) => c.type === 'video')
  check(videos.length <= MAX_VIDEO_CLIPS, '视频段不超过 100 段')
  check((draft.canvas === null) === (videos.length === 0), '画布跟着有没有视频段')
  let at = 0
  draft.layer0.forEach((clip, index) => {
    check(clip.start === at, `第 0 层首尾相接（${clip.id}）`)
    at += clip.duration
    check(clip.duration >= MIN_CLIP_MS, `片段不短于 0.1 秒（${clip.id}）`)
    if (clip.type === 'video') {
      const media = context.sources[clip.sourceJobId]
      check(clip.playbackStart >= 0, `入点不为负（${clip.id}）`)
      check(
        clip.playbackStart + clip.duration <= (media?.durationMs ?? 0),
        `不超出素材（${clip.id}）`,
      )
      check(clip.volume >= 0 && clip.volume <= MAX_VOLUME, `音量在 0–2（${clip.id}）`)
    } else {
      check(
        clip.role === 'intro' ? index === 0 : index === draft.layer0.length - 1,
        '片头在首、片尾在尾',
      )
    }
  })
  for (const role of ['intro', 'outro'] as const) {
    check(
      draft.layer0.filter((c) => c.type === 'component' && c.role === role).length <= 1,
      `${role} 至多一个`,
    )
  }
  const cutOwners = new Set<string>()
  for (const transition of draft.transitions) {
    const index = draft.layer0.findIndex((c) => c.id === transition.afterClipId)
    const before = draft.layer0[index]
    const after = draft.layer0[index + 1]
    check(Boolean(before && after), `转场挂在切点上（${transition.id}）`)
    check(!cutOwners.has(transition.afterClipId), '一个切点至多一个转场')
    cutOwners.add(transition.afterClipId)
    const spec = context.transitions[transition.component]
    check(spec?.durationMs === transition.duration, `转场时长取组件原定的（${transition.id}）`)
    if (spec) {
      const window = transitionWindow(draft, transition, {
        cutAt: spec.cutAt,
        durationMs: transition.duration,
      })
      check(window?.fits === true, `转场落在切点前后两段之内（${transition.id}）`)
    }
  }
  draft.overlays.forEach((overlay, index) => {
    const previous = draft.overlays[index - 1]
    check(overlay.duration >= MIN_CLIP_MS, `包装不短于 0.1 秒（${overlay.id}）`)
    check(
      overlay.start >= (previous ? previous.start + previous.duration : 0),
      `包装不重叠（${overlay.id}）`,
    )
    check(overlay.start + overlay.duration <= total, `包装在整片范围内（${overlay.id}）`)
  })
  check(!draft.music || draft.music.offset >= 0, '音乐起点不为负')
  return found
}

const randomEdit = (draft: WholeFilmDraft, random: () => number): EditResult => {
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)]
    if (item === undefined) throw new Error('空列表')
    return item
  }
  const total = filmDuration(draft)
  const clipId = () => pick([...draft.layer0.map((c) => c.id), 'missing'])
  const overlayId = () => pick([...draft.overlays.map((o) => o.id), 'missing'])
  const delta = () => int(-8_000, 8_000)
  const role = (): EndCardRole => pick(['intro', 'outro'])
  const edits: (() => EditResult)[] = [
    () => {
      const sourceJobId = pick(['a', 'b', 'c', 'big', 'missing'])
      const at = random() < 0.5 ? { videoIndex: int(-1, 6) } : { timeMs: int(0, total + 1_000) }
      return insertMaterial(
        draft,
        { sourceJobId, playbackStart: int(-100, 8_000), duration: int(50, 6_000), at },
        context,
      )
    },
    () => moveClip(draft, { clipId: clipId(), deltaMs: delta() }, context),
    () =>
      trimClip(
        draft,
        { clipId: clipId(), edge: pick(['start', 'end']), deltaMs: delta() },
        context,
      ),
    () => splitClip(draft, { timeMs: int(0, total) }, context),
    () => deleteClip(draft, { clipId: clipId() }, context),
    () => setClipVolume(draft, { clipId: clipId(), volume: int(-1, 3) }),
    () =>
      addEndCard(draft, {
        role: role(),
        component: 'card',
        variables: { wordmark: '拾步' },
        durationMs: int(50, 5_000),
      }),
    () =>
      replaceEndCardComponent(draft, {
        role: role(),
        component: pick(['card', 'other']),
        variables: { wordmark: '品牌' },
      }),
    () =>
      setTransition(
        draft,
        { afterClipId: clipId(), component: pick(['fade', 'wipe', 'missing']), variables: {} },
        context,
      ),
    () =>
      removeTransition(draft, {
        transitionId: pick([...draft.transitions.map((t) => t.id), 'missing']),
      }),
    () =>
      addOverlay(draft, {
        component: 'badge',
        durationMs: int(50, 6_000),
        variables: {},
        atMs: int(0, total),
      }),
    () => moveOverlay(draft, { overlayId: overlayId(), deltaMs: delta() }),
    () =>
      trimOverlay(draft, {
        overlayId: overlayId(),
        edge: pick(['start', 'end']),
        deltaMs: delta(),
      }),
    () => removeOverlay(draft, { overlayId: overlayId() }),
    () =>
      setMusic(
        draft,
        { jobId: pick(['m1', 'm2', 'missing']), offsetMs: int(-1_000, 40_000) },
        context,
      ),
    () => setMusicOffset(draft, { offsetMs: int(-1_000, 40_000) }, context),
    () => autoBeatSync(draft, context),
    () =>
      setCaptionText(draft, { subtitleJobId: 'sub', sentenceIndex: int(0, 2), text: '改过的字' }),
    () => clearCaptionText(draft, { subtitleJobId: 'sub', sentenceIndex: int(0, 2) }),
  ]
  return pick(edits)()
}

it.each([1, 2, 3, 4, 5, 6, 7, 8])('随机编辑序列（种子 %i）：每一步后草稿都满足不变量', (seed) => {
  const random = randomOf(seed)
  let history: History<WholeFilmDraft> = startHistory(draftOf([]))
  let committed = 0
  const reached = {
    fiveVideos: false,
    bothEndCards: false,
    transitions: false,
    overlays: false,
    music: false,
  }
  for (let step = 0; step < 400; step++) {
    const roll = random()
    if (roll < 0.08) history = undo(history)
    else if (roll < 0.12) history = redo(history)
    else {
      const next = commitEdit(history, randomEdit(history.present, random))
      if (next !== history) committed++
      history = next
    }
    const draft = history.present
    expect({ step, violations: violations(draft) }).toEqual({ step, violations: [] })
    reached.fiveVideos ||= draft.layer0.filter((c) => c.type === 'video').length >= 5
    reached.bothEndCards ||= draft.layer0.filter((c) => c.type === 'component').length === 2
    reached.transitions ||= draft.transitions.length > 0
    reached.overlays ||= draft.overlays.length > 0
    reached.music ||= draft.music !== null
  }
  // 随机序列要真的走到这些状态，不变量检查才有意义
  expect(committed).toBeGreaterThan(100)
  expect(reached).toEqual({
    fiveVideos: true,
    bothEndCards: true,
    transitions: true,
    overlays: true,
    music: true,
  })
})
