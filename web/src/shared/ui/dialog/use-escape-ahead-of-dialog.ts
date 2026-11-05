import { useEffect, useEffectEvent } from 'react'

export function useEscapeAheadOfDialog(active: boolean, onEscape: () => void) {
  const escape = useEffectEvent(onEscape)
  useEffect(() => {
    if (!active) return
    const claim = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      escape()
    }
    window.addEventListener('keydown', claim, { capture: true })
    return () => window.removeEventListener('keydown', claim, { capture: true })
  }, [active])
}
