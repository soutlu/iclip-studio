import { useCallback, useEffect, useState } from 'react'
import { copyText } from '@/shared/lib/clipboard'
import { toast } from '@/shared/ui/toast'

const COPY_FEEDBACK_MS = 1400

export function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copies, setCopies] = useState(0)

  useEffect(() => {
    if (copies === 0) return
    const timer = setTimeout(() => setCopies(0), COPY_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [copies])

  const copy = useCallback(async (text: string) => {
    try {
      await copyText(text)
    } catch {
      toast.error('复制失败，请重试')
      return
    }
    setCopies((count) => count + 1)
  }, [])

  return { copied: copies !== 0, copy }
}
