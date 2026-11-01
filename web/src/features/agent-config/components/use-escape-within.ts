import { useEffect, useRef, type RefObject } from 'react'

/**
 * 焦点在这块区域里时按 Esc 调 `onEscape`（收起面板、取消新建）。监听挂在区域的 DOM 上：
 * 按键来自区域里的控件，挂在 body 上的菜单等浮层的 Esc 不经过这里，只关它们自己；输入法组字时不处理。
 */
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
