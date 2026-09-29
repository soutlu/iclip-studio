import type { FocusEvent } from 'react'

/** 裁切层不会自行滚动；焦点进入被横向裁切的控件时请求恢复宽度，保留当前焦点。 */
export function revealClippedFocus(event: FocusEvent<HTMLElement>, reveal: () => void) {
  const { currentTarget, target } = event
  // Portal 的焦点也会沿 React 树冒泡，但不属于本裁切区域。
  if (!(target instanceof HTMLElement) || !currentTarget.contains(target)) return
  const visible = currentTarget.getBoundingClientRect()
  const focused = target.getBoundingClientRect()
  // 忽略边框与子像素取整造成的微小误差。
  if (focused.left < visible.left - 1 || focused.right > visible.right + 1) reveal()
}
