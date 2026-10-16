import { useBlocker } from '@tanstack/react-router'
import { toast } from '@/shared/ui/toast'

/** 任务尚未受理时阻止离开，避免中断浏览器中的参考视频制作和上传。 */
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
