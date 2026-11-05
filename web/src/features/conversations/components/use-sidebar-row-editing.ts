import { useEffect, useRef, useState } from 'react'

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
    onMenuCloseAutoFocus: () => setMenuOpen(false),
  }
}
