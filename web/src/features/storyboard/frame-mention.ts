/** 正文里敲 `@` 选图的规则：什么输入打开选图、选中后正文变成什么、方向键在格子间怎么走。 */

import { insertReferenceText } from './shot-document'

/** 一次键入：打的字、编辑器此刻能不能改、是否还在输入法组合中。粘贴与撤销不算键入。 */
export type TypedInput = { text: string; editable: boolean; composing: boolean }

/** 可编辑、不在输入法组合中、键入的正好是一个 `@` 才打开选图；前面是什么字符都不挑。 */
export const opensFrameMention = ({ composing, editable, text }: TypedInput): boolean =>
  editable && !composing && text === '@'

/** 选中第 `frame` 张图后的正文与光标：`at` 处那个 `@` 换成引用，换法与其它入口插引用是同一条规则；
 * 光标落在引用之后。`at` 处不是 `@` 时返回 undefined。 */
export const textAfterMention = (
  text: string,
  at: number,
  frame: number,
): { text: string; cursor: number } | undefined => {
  if (text[at] !== '@') return undefined
  const next = insertReferenceText(text, frame, { text, start: at, end: at + 1 })
  return { text: next, cursor: next.length - (text.length - at - 1) }
}

export type MentionArrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** 格子在屏幕上的位置。 */
export type OptionBox = { left: number; top: number; width: number; height: number }

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
