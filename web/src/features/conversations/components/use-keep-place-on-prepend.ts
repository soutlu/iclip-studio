import { type RefObject, useLayoutEffect, useRef } from 'react'

export const useKeepPlaceOnPrepend = (
  scrollerRef: RefObject<HTMLElement | null>,
  firstItemId: string | undefined,
  loadingOlder: boolean,
): (() => void) => {
  const anchorRef = useRef<{ first: string | undefined; fromBottom: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const scroller = scrollerRef.current
    if (anchor === null || loadingOlder) return
    anchorRef.current = null
    if (scroller === null || firstItemId === anchor.first) return
    scroller.scrollTop = scroller.scrollHeight - anchor.fromBottom
  }, [firstItemId, loadingOlder, scrollerRef])

  return () => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    anchorRef.current = {
      first: firstItemId,
      fromBottom: scroller.scrollHeight - scroller.scrollTop,
    }
  }
}
