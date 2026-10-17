import { useEffect, useRef, useState } from 'react'

/**
 * 侧栏一行的原位编辑与行菜单状态。
 *
 * 编辑中或菜单打开期间以 `onInteractionChange(true)` 请虚拟列表保留这一行，结束或卸载时放开。
 * 编辑结束且 `close({ refocus: true })` 时，等主控件重新挂上后把焦点还给 `returnRef`。
 * `onMenuOpenChange` 交给行菜单的 MenuRoot，`onMenuCloseAutoFocus` 交给它的 MenuSurface。
 */
export function useSidebarRowEditing<T extends HTMLElement>(
  onInteractionChange: (active: boolean) => void,
) {
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const returnRef = useRef<T>(null)
  const refocusRef = useRef(false)

  useEffect(() => {
    if (editing || !refocusRef.current) return
    refocusRef.current = false
    returnRef.current?.focus()
  }, [editing])
  useEffect(
    () => onInteractionChange(editing || menuOpen),
    [editing, menuOpen, onInteractionChange],
  )
  useEffect(() => () => onInteractionChange(false), [onInteractionChange])

  return {
    editing,
    returnRef,
    start: () => setEditing(true),
    close: ({ refocus }: { refocus: boolean }) => {
      refocusRef.current = refocus
      setEditing(false)
    },
    onMenuOpenChange: (open: boolean) => {
      if (open) setMenuOpen(true)
    },
    // Radix 在 onCloseAutoFocus 时才把焦点还给触发按钮，行要保留到这之后。
    onMenuCloseAutoFocus: () => setMenuOpen(false),
  }
}
