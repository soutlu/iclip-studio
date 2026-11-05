import { useCallback, useEffect, useRef, useState } from 'react'
import type { SubmitPhase } from '@/shared/ui/button'

export const SUBMIT_HOLD_MS = 1_500

export const useSubmitLock = () => {
  const [phase, setPhase] = useState<SubmitPhase>('idle')
  const lockRef = useRef({
    busy: false,
    mounted: true,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  })
  useEffect(() => {
    const lock = lockRef.current
    lock.mounted = true
    return () => {
      lock.mounted = false
      clearTimeout(lock.timer)
    }
  }, [])
  const run = useCallback(async (task: (mounted: () => boolean) => Promise<boolean>) => {
    const lock = lockRef.current
    if (lock.busy) return
    lock.busy = true
    setPhase('sending')
    let accepted = false
    try {
      accepted = await task(() => lock.mounted)
    } finally {
      if (!accepted) {
        lock.busy = false
        if (lock.mounted) setPhase('idle')
      }
    }
    if (!accepted || !lock.mounted) return
    setPhase('accepted')
    lock.timer = setTimeout(() => {
      lock.busy = false
      setPhase('idle')
    }, SUBMIT_HOLD_MS)
  }, [])
  return { phase, run }
}
