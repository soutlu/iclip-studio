import { useCallback, useEffect, useRef, useState } from 'react'

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 120
const WARM_REOPEN_MS = 400

let lastClosedAt = 0

export const useHoverPreview = () => {
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  const close = useCallback(() => {
    clearTimer()
    lastClosedAt = Date.now()
    setOpen(false)
  }, [clearTimer])

  const onEnter = useCallback(() => {
    clearTimer()
    const cold = Date.now() - lastClosedAt >= WARM_REOPEN_MS
    timerRef.current = setTimeout(() => setOpen(true), cold ? OPEN_DELAY_MS : 0)
  }, [clearTimer])

  const onLeave = useCallback(() => {
    clearTimer()
    timerRef.current = setTimeout(close, CLOSE_DELAY_MS)
  }, [clearTimer, close])

  return { close, onEnter, onLeave, open }
}
