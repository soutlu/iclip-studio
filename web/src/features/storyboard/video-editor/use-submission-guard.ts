import { useBlocker } from '@tanstack/react-router'
import { toast } from '@/shared/ui/toast'

export function useSubmissionGuard(busy: boolean) {
  useBlocker({
    disabled: !busy,
    enableBeforeUnload: busy,
    shouldBlockFn: () => {
      toast.info('正在提交，请等待提交完成后再离开')
      return true
    },
  })
}
