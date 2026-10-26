import { expect, it } from 'vitest'
import { contextOf, draftOf, sentence, source } from '@/testing/whole-film'
import { redo, startHistory, undo, type History } from '../../editing/edit-history'
import { autoBeatSync } from './beat-sync'
import { clearCaptionText, setCaptionText } from './captions'
import { MAX_FILM_MS, MAX_VOLUME, MIN_CLIP_MS, type WholeFilmDraft } from './draft'
import { commitEdit } from './history'
import {
  deleteClips,
  insertComponent,
  insertMaterial,
  moveClips,
  setClipsVolume,
  splitClip,
  trimClip,
} from './layer0'
import { setMusic, setMusicOffset } from './music'
import {
  addOverlay,
  dropOverlay,
  moveOverlay,
  overlayRowAt,
  overlayRowCount,
  removeOverlay,
  trimOverlay,
} from './overlays'
import type { EditResult } from './result'
import { filmDuration, layer0End } from './timeline'
import { setComponentVariables } from './variables'

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
      beats: Array.from({ length: 80 }, (_, k) => ({
        timeMs: 120 + k * 480,
        strength: k % 4 === 0 ? 1 : 0.4,
      })),
    },
    m2: { durationMs: 5_000, beats: [{ timeMs: 0, strength: 1 }] },
  },
  // 比随机放进去的时长（至多 12 秒）短，序列里也会修剪已经超出组件时长的块
  { card: 6_000, other: 3_000, badge: 4_000 },
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
    ...draft.layer0.flatMap((c) => [c.start, c.duration, c.playbackStart]),
    ...draft.overlays.flatMap((o) => [o.start, o.duration, o.playbackStart]),
    ...(draft.music ? [draft.music.offset] : []),
  ]
  check(ints.every(Number.isInteger), '时间都是整数毫秒')
  check(total <= MAX_FILM_MS, '成片不超过 120 秒')
  check(layer0End(draft) <= total, '成片不短于画面轨')
  const videos = draft.layer0.filter((c) => c.type === 'video')
  check((draft.canvas === null) === (videos.length === 0), '画布跟着有没有视频段')
  const ids = [...draft.layer0, ...draft.overlays].map((item) => item.id)
  check(new Set(ids).size === ids.length, 'id 不重复')
  let at = 0
  draft.layer0.forEach((clip) => {
    check(clip.start === at, `第 0 层首尾相接（${clip.id}）`)
    at += clip.duration
    check(clip.duration >= MIN_CLIP_MS, `片段不短于 0.1 秒（${clip.id}）`)
    check(clip.playbackStart >= 0, `入点不为负（${clip.id}）`)
    if (clip.type === 'video') {
      const media = context.sources[clip.sourceJobId]
      check(
        clip.playbackStart + clip.duration <= (media?.durationMs ?? 0),
        `不超出素材（${clip.id}）`,
      )
      check(clip.volume >= 0 && clip.volume <= MAX_VOLUME, `音量在范围内（${clip.id}）`)
    }
  })
  for (const overlay of draft.overlays) {
    check(overlay.duration >= MIN_CLIP_MS, `特效块不短于 0.1 秒（${overlay.id}）`)
    check(overlay.start >= 0 && overlay.playbackStart >= 0, `特效块不从负数开始（${overlay.id}）`)
    check(overlay.start + overlay.duration <= MAX_FILM_MS, `特效块在 120 秒前结束（${overlay.id}）`)
    check(Number.isInteger(overlay.zIndex) && overlay.zIndex >= 0, `zIndex 不为负（${overlay.id}）`)
    check(
      draft.overlays.every(
        (other) =>
          other === overlay ||
          other.track !== overlay.track ||
          other.start >= overlay.start + overlay.duration ||
          overlay.start >= other.start + other.duration,
      ),
      `同一行不重叠（${overlay.id}）`,
    )
  }
  const tracks = [...new Set(draft.overlays.map((o) => o.track))].sort((a, b) => a - b)
  check(
    tracks.every((track, index) => track === index),
    '特效轨的行号从 0 起连续',
  )
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
  /** 连着的一到三段，偶尔混进不在草稿里的 */
  const clipIds = () => {
    const from = int(0, draft.layer0.length)
    const ids = draft.layer0.slice(from, from + int(1, 3)).map((c) => c.id)
    return random() < 0.1 ? [...ids, 'missing'] : ids
  }
  const overlayId = () => pick([...draft.overlays.map((o) => o.id), 'missing'])
  const delta = () => int(-8_000, 8_000)
  const rows = overlayRowCount(draft.overlays)
  const at = () =>
    random() < 0.5 ? { index: int(-1, draft.layer0.length + 1) } : { timeMs: int(0, total + 1_000) }
  const material = () =>
    insertMaterial(
      draft,
      {
        sourceJobId: pick(['a', 'b', 'c', 'big', 'missing']),
        pieces: Array.from({ length: int(1, 3) }, () => ({
          playbackStart: int(-100, 8_000),
          duration: int(50, 6_000),
        })),
        at: at(),
      },
      context,
    )
  // 加素材常被拒（随机范围超出素材），排两份，序列才走得到五段视频以上
  const edits: (() => EditResult)[] = [
    material,
    material,
    () =>
      insertComponent(draft, {
        component: pick(['card', 'other']),
        duration: int(50, 12_000),
        variables: { wordmark: '拾步' },
        at: at(),
      }),
    () => moveClips(draft, { clipIds: clipIds(), to: int(-1, draft.layer0.length + 1) }),
    () =>
      trimClip(
        draft,
        { clipId: clipId(), edge: pick(['start', 'end']), deltaMs: delta() },
        context,
      ),
    () => splitClip(draft, { timeMs: int(0, total) }),
    () => deleteClips(draft, { clipIds: clipIds() }),
    () => setClipsVolume(draft, { clipIds: clipIds(), volume: int(-1, 5) }),
    () => setComponentVariables(draft, { id: clipId(), variables: { wordmark: '品牌' } }),
    () =>
      addOverlay(draft, {
        component: 'badge',
        durationMs: int(50, 12_000),
        variables: {},
        atMs: int(0, MAX_FILM_MS),
      }),
    () =>
      dropOverlay(draft, {
        component: 'badge',
        durationMs: int(50, 12_000),
        variables: {},
        atMs: int(0, MAX_FILM_MS),
        row: overlayRowAt(int(-10, rows * 10 + 10) / 10, rows),
      }),
    () => moveOverlay(draft, { overlayId: overlayId(), deltaMs: delta() }),
    () =>
      moveOverlay(draft, {
        overlayId: overlayId(),
        deltaMs: delta(),
        row: overlayRowAt(int(-10, rows * 10 + 10) / 10, rows),
      }),
    () =>
      trimOverlay(
        draft,
        { overlayId: overlayId(), edge: pick(['start', 'end']), deltaMs: delta() },
        context,
      ),
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
    twoComponents: false,
    componentBetweenVideos: false,
    overlays: false,
    overlayRows: false,
    music: false,
  }
  for (let step = 0; step < 800; step++) {
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
    const types = draft.layer0.map((c) => c.type)
    reached.fiveVideos ||= types.filter((type) => type === 'video').length >= 5
    reached.twoComponents ||= types.filter((type) => type === 'component').length >= 2
    reached.componentBetweenVideos ||= types.some(
      (type, index) =>
        type === 'component' && types[index - 1] === 'video' && types[index + 1] === 'video',
    )
    reached.overlays ||= draft.overlays.length > 0
    reached.overlayRows ||= overlayRowCount(draft.overlays) >= 3
    reached.music ||= draft.music !== null
  }
  // 随机序列要真的走到这些状态，不变量检查才有意义
  expect(committed).toBeGreaterThan(100)
  expect(reached).toEqual({
    fiveVideos: true,
    twoComponents: true,
    componentBetweenVideos: true,
    overlays: true,
    overlayRows: true,
    music: true,
  })
})
