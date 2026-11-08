import type { FocusEvent } from 'react'

export function revealClippedFocus(event: FocusEvent<HTMLElement>, reveal: () => void) {
  const { currentTarget, target } = event
  if (!(target instanceof HTMLElement) || !currentTarget.contains(target)) return
  const visible = currentTarget.getBoundingClientRect()
  const focused = target.getBoundingClientRect()
  if (focused.left < visible.left - 1 || focused.right > visible.right + 1) reveal()
}
