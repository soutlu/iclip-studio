import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { UsersSection } from './users-section'

type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 「设置」弹窗：高度固定，内容在分区里滚动。目前只有「用户」一个分区。 */
export function SettingsDialog({ onOpenChange, open }: SettingsDialogProps) {
  return (
    <DialogRoot onOpenChange={onOpenChange} open={open}>
      <DialogSurface
        aria-describedby={undefined}
        className="h-[min(640px,86vh)] max-w-[720px] max-sm:h-[92vh]"
      >
        <DialogHeader closeLabel="关闭设置" title="设置" />
        {open ? <UsersSection /> : null}
      </DialogSurface>
    </DialogRoot>
  )
}
