import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import {
  arrowStep,
  DRAG_THRESHOLD,
  releasePointer,
  useClickAfterDrag,
  type Edge,
} from '../editing/timeline-drag'
import { groupShift, timingOf, type Timing } from './clip-edit'
import type { FilmClip } from './composition/film'
import { useEditorEscape } from './editor-keys'
import { beatsToSnap, snapEdgeToBeats, snapSpanToBeats } from './music-beats'
import { sameRow, zoneOf, type RowTarget } from './placement'
import { laneOf, rowKeyOf, togglesSelection } from './timeline-lanes'
import type { TimelineClipProps } from './timeline-clip'
import { pxToMs, snapTargets } from './timeline-scale'

const sameTiming = (left: Timing, right: Timing) =>
  left.start === right.start &&
  left.duration === right.duration &&
  left.mediaStart === right.mediaStart

export type Gesture = {
  pointerId: number
  kind: 'move' | Edge
  originX: number
  originY: number
  /** 按下的地方离片段的开头多远（毫秒），挪的时候片段跟着指针走而不是跳到指针处。 */
  grabMs: number
  /** 一起动的片段（含它自己）：开始拖的那一刻定下来，中途选中变了也不换；还没开始拖时是 null。 */
  group: ReadonlySet<string> | null
  timing: Timing | null
  /** 挪的时候片段要去哪一行：已有的行，或者要新开的那一行。 */
  row: RowTarget | null
  /** 跟着一起动的别的片段各自的时间。 */
  followers: ReadonlyMap<string, Timing>
}

/** 拖动中的片段按这个画：时间、正在拖的是哪一部分、要去哪一行（裁剪时是 null）。 */
type Preview = { timing: Timing; kind: Gesture['kind']; row: RowTarget | null }

/** 成组拖动中跟着动的片段按这个画：拖的是哪一部分，各自的时间。 */
export type Following = { kind: Gesture['kind']; timings: ReadonlyMap<string, Timing> }

/** 一个片段这一端在 final-cut 里的时间（毫秒）。 */
export const edgeAt = (clip: Timing, edge: Edge) =>
  edge === 'start' ? clip.start : clip.start + clip.duration

/** `timings` 里和 final-cut 里现在不一样的那些。 */
const changedTimings = (
  clips: readonly FilmClip[],
  timings: ReadonlyMap<string, Timing>,
): Map<string, Timing> =>
  new Map(
    [...timings].filter(([id, timing]) => {
      const clip = clips.find((other) => other.id === id)
      return clip !== undefined && !sameTiming(timing, timingOf(clip))
    }),
  )

/** 挪动的落点：被抓的片段去哪一行、从哪里起，跟着走的片段各自的新时间。 */
type MovePlan = { row: RowTarget; start: number; followers: Map<string, Timing> }

/**
 * 被抓的 `clip` 想从 `startMs` 起、去 `row` 这一行时，它和一起挪的片段（`group`，含它自己）落在哪里。
 * 一起挪的片段挪同一个时间差，跟着走的片段留在各自的行；被抓的片段换不过去就留在自己那一行。
 * 只挪一个片段也走这里，它自己就是一组。
 */
const movePlan = (
  clips: readonly FilmClip[],
  clip: FilmClip,
  group: ReadonlySet<string>,
  startMs: number,
  row: RowTarget,
): MovePlan => {
  const shift = groupShift(
    clip,
    group,
    clips,
    startMs - clip.start,
    'track' in row ? row.track : null,
  )
  const followers = new Map(
    clips
      .filter((other) => group.has(other.id) && other.id !== clip.id)
      .map((other) => {
        const timing = timingOf(other)
        return [other.id, { ...timing, start: timing.start + shift.delta }]
      }),
  )
  return {
    row: shift.track === null ? row : { zone: zoneOf(clip), track: shift.track },
    start: clip.start + shift.delta,
    followers,
  }
}

/** 片段手势要用的片段状态与回调；与时间线片段同名属性的含义一致。 */
type ClipGestureOptions = Pick<
  TimelineClipProps,
  | 'clip'
  | 'clips'
  | 'groupFor'
  | 'pps'
  | 'contentRef'
  | 'rowAt'
  | 'onOpening'
  | 'trimTo'
  | 'snap'
  | 'snapBeats'
  | 'playheadMs'
  | 'onGuide'
  | 'onFollow'
  | 'onGesture'
  | 'onRetime'
  | 'onMove'
> & {
  /** 片段的根节点：拖去别的行时把它画到那一行上。 */
  rootRef: RefObject<HTMLDivElement | null>
}

/**
 * 时间线上一个片段的拖动和裁剪：按下、拖过阈值才开始（定下一起动的片段），挪动吸附、换行、新开一行，裁剪吸附，
 * 方向键微调两端；松手才写进 final-cut，拖动中按 Esc、片段被删掉或 final-cut 被换掉时什么都不写。
 * 返回拖动中的样子（没在拖时是 undefined）、拖完松手那次点击的吞掉开关，和挂在片段身体、把手上的处理函数。
 */
export function useClipGesture({
  clip,
  clips,
  groupFor,
  pps,
  contentRef,
  rowAt,
  onOpening,
  trimTo,
  snap,
  snapBeats,
  playheadMs,
  onGuide,
  onFollow,
  onGesture,
  onRetime,
  onMove,
  rootRef,
}: ClipGestureOptions) {
  const gestureRef = useRef<Gesture | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [preview, setPreview] = useState<Preview>()
  const aimed = preview?.row ?? null
  // 拖去别的行时把片段画到那一行上。那一行可能是这一次才让出来的，要等排好版再量它在哪
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const own = root.parentElement
    const target = aimed === null ? null : laneOf(contentRef.current, aimed)
    root.style.translate =
      own === null || target === null
        ? ''
        : `0 ${target.getBoundingClientRect().top - own.getBoundingClientRect().top}px`
  })

  const timeAt = (clientX: number) =>
    pxToMs(clientX - (contentRef.current?.getBoundingClientRect().left ?? 0), pps)

  const press = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0) return
    event.stopPropagation()
    clickAfterDrag.reset()
    // 带着加减选中的键按下只算点选，不开始拖
    if (togglesSelection(event)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const box = event.currentTarget.closest('[data-clip-id]')?.getBoundingClientRect()
    gestureRef.current = {
      pointerId: event.pointerId,
      kind,
      originX: event.clientX,
      originY: event.clientY,
      grabMs: box === undefined ? 0 : pxToMs(event.clientX - box.left, pps),
      group: null,
      timing: null,
      row: null,
      followers: new Map(),
    }
  }

  // 把手是哪一端从它自己身上读（TrimHandle 给开头那个加 is-start），这样两个把手共用一个处理函数
  const pressEdge = (event: PointerEvent<HTMLElement>) =>
    press(event, event.currentTarget.classList.contains('is-start') ? 'start' : 'end')

  const drag = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    // 挪动可以往上下拖去别的行；裁剪只看左右
    const moved =
      gesture.kind === 'move'
        ? Math.hypot(event.clientX - gesture.originX, event.clientY - gesture.originY)
        : Math.abs(event.clientX - gesture.originX)
    if (gesture.timing === null && moved <= DRAG_THRESHOLD) return
    if (gesture.group === null) onGesture(true)
    // 开始拖的那一刻定下一起动的片段
    gesture.group ??= groupFor(gesture.kind)
    const members = gesture.group
    const at = timeAt(event.clientX)
    const { kind } = gesture
    // 开着吸附时：没在动的片段的两端和播放头是能吸上去的点（一起动的片段拖动前的边不算）；
    // 都没吸上时再吸没在动的配乐的节拍（配乐自己不吸自己的节拍）
    const targets = snap
      ? snapTargets(
          clips.filter((other) => !members.has(other.id)),
          playheadMs,
        )
      : null
    const beats = snap ? beatsToSnap(snapBeats, members) : []
    if (kind === 'move') {
      const wanted = Math.max(0, at - gesture.grabMs)
      const snapped =
        targets === null
          ? { ms: wanted, guideMs: null }
          : snapSpanToBeats(wanted, clip.duration, targets, beats, pps)
      // 指针在哪一行上，片段就去它自己的区里对着的那一行；在两行之间就在那里新开一行；都不是就留在原来的行
      const row = rowAt(event.clientY, true, zoneOf(clip)) ?? rowKeyOf(clip)
      const plan = movePlan(clips, clip, members, snapped.ms, row)
      gesture.timing = { ...timingOf(clip), start: plan.start }
      gesture.row = plan.row
      gesture.followers = plan.followers
      onOpening('insertAt' in plan.row ? plan.row.insertAt : null)
      // 吸上去的位置被别的片段占了、又挪开了，就不画吸附线
      onGuide(plan.start === snapped.ms ? snapped.guideMs : null)
    } else {
      const snapped =
        targets === null ? { ms: at, guideMs: null } : snapEdgeToBeats(at, targets, beats, pps)
      const timings = trimTo(clip, members, kind, snapped.ms)
      const next = timings.get(clip.id) ?? timingOf(clip)
      gesture.timing = next
      gesture.followers = new Map([...timings].filter(([id]) => id !== clip.id))
      onGuide(edgeAt(next, kind) === snapped.ms ? snapped.guideMs : null)
    }
    setPreview({ timing: gesture.timing, kind, row: gesture.row })
    onFollow(gesture.followers.size === 0 ? null : { kind, timings: gesture.followers })
  }

  /** 收起这次拖动的样子；拖动已经开始的才算结束一次拖动。 */
  const finish = () => {
    const started = (gestureRef.current?.group ?? null) !== null
    gestureRef.current = null
    setPreview(undefined)
    onGuide(null)
    onOpening(null)
    onFollow(null)
    if (started) onGesture(false)
  }

  const release = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    releasePointer(event)
    finish()
    if (gesture.timing === null) return
    // 拖完松手也会来一次点击，那一次不算选中
    clickAfterDrag.swallow()
    if (gesture.row !== null && !sameRow(gesture.row, rowKeyOf(clip))) {
      const starts = new Map([...gesture.followers].map(([id, timing]) => [id, timing.start]))
      onMove(clip.id, gesture.row, gesture.timing.start, starts)
      return
    }
    const changed = changedTimings(
      clips,
      new Map([[clip.id, gesture.timing], ...gesture.followers]),
    )
    if (changed.size > 0) onRetime(changed)
  }

  // 拖动中按 Esc：取消这次拖动，什么都不写；之后松手带来的那次点击也不算选中
  useEditorEscape(preview !== undefined, () => {
    clickAfterDrag.swallow()
    finish()
  })

  // 拖着的片段中途被删掉或撤销掉：它留在时间线和编辑器里的拖动状态一起收起
  const abandon = useEffectEvent(() => {
    if ((gestureRef.current?.group ?? null) !== null) finish()
  })
  useEffect(() => () => abandon(), [])

  // 拖动中 final-cut 被换掉（撤销了，或者别处存了更新的一版）：松手会按换之前算好的位置写回去，
  // 所以取消这次拖动，之后松手带来的那次点击也不算选中
  const dropStale = useEffectEvent(() => {
    if ((gestureRef.current?.group ?? null) === null) return
    clickAfterDrag.swallow()
    finish()
  })
  useEffect(() => dropStale(), [clips])

  const nudge = (event: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step = arrowStep(event)
    if (step === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const changed = changedTimings(
      clips,
      trimTo(clip, groupFor(edge), edge, edgeAt(timingOf(clip), edge) + Math.round(step * 1000)),
    )
    if (changed.size > 0) onRetime(changed)
  }

  return { preview, clickAfterDrag, press, pressEdge, drag, finish, release, nudge }
}
