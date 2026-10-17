import { useRef } from 'react'

/**
 * 不经 Dialog.Trigger 打开的弹窗，Radix 关闭时找不到触发器，焦点落回 body；打开时记下焦点所在的元素，关闭时还给它。
 * 打开者已不在页面或本无打开者时，沿用 Radix 默认处理。
 */
export function useOpenerFocus() {
  const openerRef = useRef<HTMLElement | null>(null)
  return {
    remember: () => {
      const active = document.activeElement
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    },
    restore: (event: Event) => {
      const opener = openerRef.current
      openerRef.current = null
      if (event.defaultPrevented || opener === null || !opener.isConnected) return
      event.preventDefault()
      opener.focus()
    },
  }
}
