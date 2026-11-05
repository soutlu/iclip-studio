import { useLayoutEffect, useRef, useState } from 'react'

export function useClampable(lines: number, content: unknown) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [clampable, setClampable] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const style = getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 21
    setClampable(el.scrollHeight > lines * lineHeight + 1)
  }, [lines, content])

  return { clampable, ref }
}
