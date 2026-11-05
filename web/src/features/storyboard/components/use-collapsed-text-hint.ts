import { useState } from 'react'

export const useCollapsedTextHint = () => {
  const [text, setText] = useState<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  return {
    bindText: setText,
    tooltip: {
      open,
      onOpenChange: (next: boolean) => setOpen(next && textHidden(text)),
    },
  }
}

const textHidden = (text: HTMLElement | null) =>
  text !== null && getComputedStyle(text).display === 'none'
