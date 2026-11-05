import { useEffect, useRef, type RefObject } from 'react'

export const useEscapeWithin = (ref: RefObject<HTMLElement | null>, onEscape: () => void): void => {
  const onEscapeRef = useRef(onEscape)
  useEffect(() => {
    onEscapeRef.current = onEscape
  })
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      event.preventDefault()
      onEscapeRef.current()
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [ref])
}
