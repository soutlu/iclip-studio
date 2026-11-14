/** 屏幕上的一个矩形（像素）。 */
export type Box = { left: number; top: number; width: number; height: number }

/** 框选怎么改原有的选中：换成框住的、加进去、从里面去掉。 */
export type MarqueeMode = 'replace' | 'add' | 'subtract'

/** 从按下的点拖到现在这个点画出的框，往哪个方向拖都行。 */
export const boxBetween = (from: { x: number; y: number }, to: { x: number; y: number }): Box => ({
  left: Math.min(from.x, to.x),
  top: Math.min(from.y, to.y),
  width: Math.abs(to.x - from.x),
  height: Math.abs(to.y - from.y),
})

// 只碰到边不算相交
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top

/**
 * 框选的方式：带 Alt 是去掉，带 Shift 是加；都不带时看按下的那一下，按下时带着 ⌘ 或 Ctrl 也是加。
 * `adding` 是按下时带没带 ⌘ / Ctrl，`keys` 是拖动中或松手时按着的键。
 */
export const marqueeMode = (
  adding: boolean,
  keys: { shiftKey: boolean; altKey: boolean },
): MarqueeMode => (keys.altKey ? 'subtract' : keys.shiftKey || adding ? 'add' : 'replace')

/** 框选之后选中哪些片段：和框相交的片段按 `mode` 换掉、加进或去掉 `base` 里的。 */
export const marqueeSelection = (
  clips: readonly { id: string; box: Box }[],
  marquee: Box,
  base: ReadonlySet<string>,
  mode: MarqueeMode,
): ReadonlySet<string> => {
  const hits = clips.filter(({ box }) => overlaps(box, marquee)).map(({ id }) => id)
  if (mode === 'replace') return new Set(hits)
  const next = new Set(base)
  for (const id of hits) {
    if (mode === 'add') next.add(id)
    else next.delete(id)
  }
  return next
}

/** 拖 `id` 这个片段（挪动或裁剪）时一起动的片段，含它自己：它在不止一个片段的选中里就是整个选中，不然只有它。 */
export const movingWith = (selected: ReadonlySet<string>, id: string): ReadonlySet<string> =>
  selected.size > 1 && selected.has(id) ? selected : new Set([id])

/**
 * 播放头左边或右边的片段，所有行一起：左边是起点早于播放头的，右边是结尾晚于播放头的；
 * 跨着播放头的两边都算，正好从播放头开始的不算左边、正好在播放头结束的不算右边。
 */
export const aroundPlayhead = (
  clips: readonly { id: string; start: number; duration: number }[],
  playheadMs: number,
  side: 'left' | 'right',
): string[] =>
  clips
    .filter((clip) =>
      side === 'left' ? clip.start < playheadMs : clip.start + clip.duration > playheadMs,
    )
    .map((clip) => clip.id)
