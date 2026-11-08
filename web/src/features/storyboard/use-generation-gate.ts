import { useCallback, useState } from 'react'
import { useSubmitLock } from './use-submit-lock'

export const useGenerationGate = () => {
  const { phase, run: runLocked } = useSubmitLock()
  const [uploadingGroups, setUploadingGroups] = useState<ReadonlySet<number>>(() => new Set())
  const onUploadingChange = useCallback((group: number, uploading: boolean) => {
    setUploadingGroups((current) => {
      if (current.has(group) === uploading) return current
      const next = new Set(current)
      if (uploading) next.add(group)
      else next.delete(group)
      return next
    })
  }, [])
  const uploading = uploadingGroups.size > 0
  const run = useCallback(
    async (task: (mounted: () => boolean) => Promise<boolean>) => {
      if (uploading) return
      await runLocked(task)
    },
    [runLocked, uploading],
  )
  return { onUploadingChange, phase, preparing: phase === 'sending', run, uploading }
}
