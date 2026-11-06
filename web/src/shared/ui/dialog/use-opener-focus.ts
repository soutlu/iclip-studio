import { useRef } from 'react'

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
