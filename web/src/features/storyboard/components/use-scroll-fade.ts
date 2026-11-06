import { useEffect, useState } from 'react'
import { scrollFadeOf, type ScrollFade } from '../scroll-fade'

export function useScrollFade(ref: { current: HTMLElement | null }): {
  fade: ScrollFade
  width: number
} {
  const [state, setState] = useState<{ fade: ScrollFade; width: number }>({
    fade: 'none',
    width: 0,
  })
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => {
      const next = { fade: scrollFadeOf(element), width: element.clientWidth }
      setState((previous) =>
        previous.fade === next.fade && previous.width === next.width ? previous : next,
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [ref])
  return state
}
