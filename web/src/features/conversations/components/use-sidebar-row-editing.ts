import { useEffect, useRef, useState } from 'react'

/**
 * 行的编辑开关：编辑结束且 refocus 时，把焦点还给 returnRef 指向的主控件（标题链接、合集按钮）。
 * 主控件在编辑期间卸载，等它重新挂上后再聚焦。
 */
export function useSidebarRowEditing<T extends HTMLElement>() {
  const [editing, setEditing] = useState(false)
  const returnRef = useRef<T>(null)
  const refocusRef = useRef(false)

  useEffect(() => {
    if (editing || !refocusRef.current) return
    refocusRef.current = false
    returnRef.current?.focus()
  }, [editing])

  return {
    editing,
    returnRef,
    start: () => setEditing(true),
    close: ({ refocus }: { refocus: boolean }) => {
      refocusRef.current = refocus
      setEditing(false)
    },
  }
}
