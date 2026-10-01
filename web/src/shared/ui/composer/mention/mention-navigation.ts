/** `@` 菜单里方向键怎么走：菜单拦哪些方向键，按下之后停到第几项。 */

export type MentionArrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** 选项在屏幕上的位置。 */
export type OptionBox = { left: number; top: number; width: number; height: number }

/** 导航策略：`arrows` 是菜单打开时拦下的方向键，其余方向键照常移动光标；
 * `next` 按当前项、方向键与各选项（`role="option"` 的文档顺序）的位置给出下一项。 */
export type MentionNavigation = {
  readonly arrows: readonly MentionArrow[]
  readonly next: (index: number, arrow: MentionArrow, boxes: readonly OptionBox[]) => number
}

const centerOf = (box: OptionBox) => box.left + box.width / 2
const bottomOf = (box: OptionBox) => box.top + box.height
/** 竖向有重叠就算同一行：各格内边距不同，`top` 未必完全相等。 */
const sameRow = (a: OptionBox, b: OptionBox) => a.top < bottomOf(b) && b.top < bottomOf(a)

/** 方向键之后选中第几格：← → 按顺序走、到头停住；↑ ↓ 换到紧挨着的上一行 / 下一行里水平中心最近的那格，没有那一行就不动。 */
export const optionAfterArrow = (
  index: number,
  arrow: MentionArrow,
  boxes: readonly OptionBox[],
): number => {
  if (arrow === 'ArrowLeft') return Math.max(0, index - 1)
  if (arrow === 'ArrowRight') return Math.min(boxes.length - 1, index + 1)
  const current = boxes[index]
  if (current === undefined) return index
  const up = arrow === 'ArrowUp'
  const beyond = boxes.filter((box) =>
    up ? bottomOf(box) <= current.top : box.top >= bottomOf(current),
  )
  const nearest = beyond.reduce<OptionBox | undefined>(
    (best, box) =>
      best === undefined || (up ? bottomOf(box) > bottomOf(best) : box.top < best.top) ? box : best,
    undefined,
  )
  if (nearest === undefined) return index
  let best = index
  let distance = Number.POSITIVE_INFINITY
  for (const [position, box] of boxes.entries()) {
    if (!beyond.includes(box) || !sameRow(box, nearest)) continue
    const gap = Math.abs(centerOf(box) - centerOf(current))
    if (gap < distance) {
      best = position
      distance = gap
    }
  }
  return best
}

/** 竖排列表：只拦 ↑ ↓，按顺序走、到头停住；← → 留给光标，查询模式下用来改查询词。 */
export const linearNavigation: MentionNavigation = {
  arrows: ['ArrowUp', 'ArrowDown'],
  next: (index, arrow, boxes) =>
    arrow === 'ArrowUp'
      ? Math.max(0, index - 1)
      : arrow === 'ArrowDown'
        ? Math.max(0, Math.min(boxes.length - 1, index + 1))
        : index,
}

/** 换行排开的格子：四个方向键都拦，规则见 `optionAfterArrow`。 */
export const gridNavigation: MentionNavigation = {
  arrows: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
  next: optionAfterArrow,
}
