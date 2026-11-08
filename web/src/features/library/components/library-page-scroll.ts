import { useCallback, useRef } from 'react'

export function useLibraryPageScroll() {
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  return { getScrollElement, mainRef }
}
