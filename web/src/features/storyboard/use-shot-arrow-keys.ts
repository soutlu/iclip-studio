/** 焦点在分镜工作台里时，↑↓ 切到上一组、下一组。 */

import { useEffect, useEffectEvent } from 'react'

/** 方向键归它们自己的地方：正在输入、下拉、单选组、菜单与弹窗。 */
const OWNS_ARROW_KEYS =
  'input, select, textarea, [contenteditable="true"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="dialog"]'

type ArrowKey = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey' | 'shiftKey' | 'target'
>

/** 这一下按键要切到第几组（从 1 起）；不是 ↑↓、带修饰键、别人已处理、落在自带方向键的控件里或已到头时为 undefined。 */
export const shotAfterArrowKey = (
  event: ArrowKey,
  position: number,
  total: number,
): number | undefined => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return undefined
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return undefined
  if (event.target instanceof Element && event.target.closest(OWNS_ARROW_KEYS) !== null)
    return undefined
  const next = position + (event.key === 'ArrowDown' ? 1 : -1)
  return next >= 1 && next <= total ? next : undefined
}

/** 在 `root` 上监听 ↑↓；`enabled` 为 false 时（例如浮层盖着）不切。切了就吞掉按键，页面不跟着滚。 */
export const useShotArrowKeys = (
  root: HTMLElement | null,
  options: { enabled: boolean; position: number; total: number; onGo: (shot: number) => void },
) => {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (!options.enabled) return
    const next = shotAfterArrowKey(event, options.position, options.total)
    if (next === undefined) return
    event.preventDefault()
    options.onGo(next)
  })
  useEffect(() => {
    if (root === null) return
    const onKeyDown = (event: KeyboardEvent) => handle(event)
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [root])
}
