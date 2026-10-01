/** 正文里敲 `@` 选图后正文变成什么；什么输入打开菜单、方向键怎么走由 shared 的 `@` 菜单内核决定。 */

import { insertReferenceText } from './shot-document'

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
