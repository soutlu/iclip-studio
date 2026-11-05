/** 付费提交的锁：请求发出期间锁住，受理后再锁 1.5 秒。受理常常很快，不多锁这一下，页面马上又能点，
 * 再点一次就多一条付费任务。失败立刻解锁，让人能马上重试。 */
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
  /** `task` 返回受理与否；抛错视同没受理，错误继续往外抛。 */
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
