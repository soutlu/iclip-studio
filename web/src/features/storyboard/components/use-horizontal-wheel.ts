import { useEffect } from 'react'

const scrollsVertically = (element: Element): boolean => {
  if (element.scrollHeight <= element.clientHeight) return false
  const { overflowY } = getComputedStyle(element)
  return overflowY === 'auto' || overflowY === 'scroll'
}

/**
 * 让隐藏了滚动条的横滑行接住鼠标竖向滚轮：竖向位移按像素加到 scrollLeft 上。
 * 横向位移、按着 Ctrl 或 Shift、行放得下、行已滚到头时都不拦截，交还浏览器。
 */
export function useHorizontalWheel(ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      if (element.scrollWidth <= element.clientWidth) return
      // 上下排时行在竖向滚动的主体里，滚轮留给主体翻页，否则鼠标停在行上页面就滚不动。
      for (let node = element.parentElement; node !== null; node = node.parentElement)
        if (scrollsVertically(node)) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1
      const before = element.scrollLeft
      element.scrollLeft = before + event.deltaY * unit
      if (element.scrollLeft !== before) event.preventDefault()
    }
    // React 的 onWheel 是被动监听器，调不了 preventDefault，竖向滚轮会同时滚动外层。
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [ref])
}
