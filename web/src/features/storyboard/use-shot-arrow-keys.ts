import { useEffect, useEffectEvent } from 'react'

const OWNS_ARROW_KEYS =
  'input, select, textarea, [contenteditable="true"], [role="radiogroup"], [role="listbox"], [role="menu"], [aria-haspopup="menu"], [role="dialog"]'

type ArrowKey = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey' | 'shiftKey' | 'target'
>

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

export const useShotArrowKeys = (
  root: HTMLElement | null,
  options: { position: number; total: number; onGo: (shot: number) => void },
) => {
  const handle = useEffectEvent((event: KeyboardEvent) => {
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
