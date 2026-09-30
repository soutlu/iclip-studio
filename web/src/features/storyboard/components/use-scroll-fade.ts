/** 量横向滚动行：哪一端还能滚（规则见 `scrollFadeOf`）和它的可见宽度。 */

import { useEffect, useState } from 'react'
import { scrollFadeOf, type ScrollFade } from '../scroll-fade'

/** 滚动、滚动行自己变宽变窄、挂上时就在的直接子元素变大变小，都重量一次；
 * 内容要包在一个常驻的子元素里，里面增减条目才量得到。挂上之前是 `none` 与 0。 */
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
    // ResizeObserver 开始观察时会先回调一次，初始状态由它量，不在副作用里同步设。
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
