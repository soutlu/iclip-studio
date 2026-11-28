import type { RefObject } from 'react'
import type { FilmClip } from './composition/film'
import { zoneOf, type Aim, type Row, type RowKey, type RowTarget } from './placement'

// 指针距待新建空行上下边缘在该像素内即判定悬停命中
const ROW_REACH_PX = 3

/** 按下的元素所在的片段（片段的身体、把手、音量曲线都算）；不在片段上时是 undefined。 */
export const clipIdAt = (target: EventTarget): string | undefined =>
  target instanceof Element
    ? target.closest<HTMLElement>('[data-clip-id]')?.dataset['clipId']
    : undefined

export const rowKeyOf = (clip: FilmClip): RowKey => ({ zone: zoneOf(clip), track: clip.track })

/**
 * 一条行在屏幕上的上下边；`insertAt` 是待新开的那一行在第几行的位置，已有的行是 null；`hint` 是配音行的引导那一行
 * （它顶着的位置不是让出来的）。
 */
type Lane = { top: number; bottom: number; insertAt: number | null; hint: boolean }

/**
 * 别处让出了一行（`opened`）时，各行按没让出来的样子摆回去：它下面的行往上挪回它占的高度，
 * 最下面那条空行（让行时收起来了）回到最后一行下面。片段只能在自己的区里新开一行，让出来的这一行
 * 常常不在指针下面；按让完的样子量，指针下面换成了别的行，又会把这一行收回去，来回跳。
 */
const withoutOpening = (lanes: readonly Lane[], opened: Lane): Lane[] => {
  const rest = lanes.filter((lane) => lane !== opened)
  const after = rest.find((lane) => lane.top > opened.top)
  const shift = after === undefined ? 0 : after.top - opened.top
  const restored = rest.map((lane) =>
    lane.top > opened.top ? { ...lane, top: lane.top - shift, bottom: lane.bottom - shift } : lane,
  )
  const last = restored.at(-1)
  if (last === undefined) return restored
  const height = opened.bottom - opened.top
  return [
    ...restored,
    {
      top: last.bottom + shift - height,
      bottom: last.bottom + shift,
      // 已有的行有几行，最下面那条空行就在第几行的位置（配音行的引导不是一行）
      insertAt: restored.filter((lane) => lane.insertAt === null).length,
      hint: false,
    },
  ]
}

/** `row` 在页面上是哪一条：已有的行，或者待新开的那一行（让出来的空行、最下面那条空行）。 */
export const laneOf = (content: HTMLElement | null, row: RowTarget) =>
  content?.querySelector<HTMLElement>(
    'track' in row
      ? `[data-zone="${row.zone}"][data-track="${row.track}"]`
      : `[data-insert-at="${row.insertAt}"]`,
  ) ?? null

/** 按着 Shift、⌘ 或 Ctrl 点片段是逐个加减选中。 */
export const togglesSelection = (event: {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}) => event.shiftKey || event.metaKey || event.ctrlKey

export const keyOf = (row: RowKey) => `${row.zone}-${row.track}`

// 片段和空档的右键菜单挂在别处，但它们的事件也会沿着组件树传到这里：只认各行里面的
export const inLanes = (event: { target: EventTarget; currentTarget: HTMLElement }) =>
  event.target instanceof Node && event.currentTarget.contains(event.target)

/** 量各行在屏幕上的位置要用的三处：滚动容器、时间尺那一条、时间区。 */
type LaneRefs = {
  scrollRef: RefObject<HTMLDivElement | null>
  rulerBarRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}

/**
 * 指针对着哪里：时间线上的第几行（`rows` 是时间线上的各行），或者在第几行的位置新开一行。只认轨道区里露出来的部分：
 * 滚到时间尺底下、滚出轨道区的行，指针看不见也落不上去。
 * 两行之间的缝（含第一行上面、最后一行下面）：`between` 为真时算在那里新开一行；
 * 为假时只有第一行上面算新开一行，别的缝归离得近的那一行。
 */
export const aimAt = (
  { scrollRef, rulerBarRef, contentRef }: LaneRefs,
  rows: readonly Row[],
  clientY: number,
  between: boolean,
): Aim | undefined => {
  const viewport = scrollRef.current
  const rulerBar = rulerBarRef.current
  if (viewport === null || rulerBar === null) return undefined
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  if (clientY < top || clientY > top + viewport.clientHeight) return undefined
  // 配音行的引导：顶着一处新开行的位置时和最下面那条空行一样算（指针在它上面就在那里新开一行），只写着字的不算
  const measured: Lane[] = [
    ...(contentRef.current?.querySelectorAll<HTMLElement>('.wf-lane') ?? []),
  ].flatMap((lane) => {
    const { top, bottom } = lane.getBoundingClientRect()
    const insertAt = lane.dataset['insertAt']
    const hint = lane.dataset['hint'] !== undefined
    if (hint && insertAt === undefined) return []
    return [{ top, bottom, insertAt: insertAt === undefined ? null : Number(insertAt), hint }]
  })
  // 指针在时间尺上：第一行露着（没滚到时间尺底下）就算在最上面新开一行，不然哪一行都不算
  const rulerBottom = rulerBar.getBoundingClientRect().bottom
  if (clientY < rulerBottom) {
    const first = measured.find((lane) => lane.insertAt === null)
    return rows.length > 0 && first !== undefined && first.top >= rulerBottom
      ? { insertAt: 0 }
      : undefined
  }
  const near = (lane: Lane) =>
    clientY >= lane.top - ROW_REACH_PX && clientY <= lane.bottom + ROW_REACH_PX
  // 已经让出来的那一行：指针还在它上面就还是它（引导顶上的那一处没有让，不算）
  const opened = measured.find(
    (lane) => lane.insertAt !== null && lane.insertAt < rows.length && !lane.hint,
  )
  if (opened?.insertAt != null && near(opened)) return { insertAt: opened.insertAt }
  const lanes = opened === undefined ? measured : withoutOpening(measured, opened)
  // 最下面那条空行：指针在它上面就在那里新开一行
  const waiting = lanes.find((lane) => lane.insertAt !== null && near(lane))
  if (waiting?.insertAt != null) return { insertAt: waiting.insertAt }
  const existing = lanes.filter((lane) => lane.insertAt === null)
  const on = existing.findIndex((lane) => clientY >= lane.top && clientY <= lane.bottom)
  if (on !== -1) return { at: on }
  // 还没有片段时只有一条空行，没有可新开的地方
  if (rows.length === 0) return undefined
  // 指针在第几行的上面那道缝里；比最后一行还靠下时只认紧挨着它的那道缝
  const under = existing.findIndex((lane) => clientY < lane.top)
  const seam = under === -1 ? existing.length : under
  const above = existing[seam - 1]
  const below = existing[seam]
  if (below === undefined && (above === undefined || clientY > above.bottom + 2 * ROW_REACH_PX))
    return undefined
  if (between || above === undefined) return { insertAt: seam }
  return below === undefined || clientY - above.bottom <= below.top - clientY
    ? { at: seam - 1 }
    : { at: seam }
}
