import { useState } from 'react'

export const useCollapsedTextHint = (always: boolean) => {
  const [text, setText] = useState<HTMLSpanElement | null>(null)
  const [wanted, setWanted] = useState(false)
  return {
    bindText: setText,
    tooltip: {
      open: wanted && (always || textHidden(text)),
      onOpenChange: setWanted,
    },
  }
}

const textHidden = (text: HTMLElement | null) =>
  text !== null && getComputedStyle(text).display === 'none'
