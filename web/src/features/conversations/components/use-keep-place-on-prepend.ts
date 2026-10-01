import { type RefObject, useLayoutEffect, useRef } from 'react'

/**
 * 旧页插在最上面时，浏览器保持 scrollTop 不变，眼前的内容会被顶下去。点之前记下到底部的距离，旧页落地
 * （最早一轮变了）后按它把 scrollTop 补回来；读完却没变（失败或没有更早的）就作罢。不依赖 CSS overflow-anchor。
 */
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
