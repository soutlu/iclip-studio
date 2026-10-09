import { errorMessageOf } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import { useDeleteConversation } from '../conversations.api'

type ConversationDeleteDialogProps = {
  conversation?: { id: string; title: string } | undefined
  onOpenChange: (open: boolean) => void
  open: boolean
}

/** 删除对话前的确认；确认后才删，成功即关闭，失败留在弹窗里报错。列表由删除 mutation 自己刷新。 */
export function ConversationDeleteDialog({
  conversation,
  onOpenChange,
  open,
}: ConversationDeleteDialogProps) {
  const remove = useDeleteConversation()

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label="删除该任务？">
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title="删除该任务？"
        />
        <DialogBody className="flex flex-col gap-2 px-6 pt-2.5 pb-6">
          <p className="text-body break-all text-on-surface">{conversation?.title}</p>
          <p className="text-body-sm text-on-surface-variant">
            删除后，该任务将不再出现在侧栏和搜索结果中
          </p>
        </DialogBody>
        <DialogFooter>
          <span />
          <div className="flex gap-2">
            <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
              取消
            </Button>
            <Button
              className="min-w-[74px]"
              loading={remove.isPending}
              onClick={() => {
                if (!conversation) return
                remove.mutate(conversation.id, {
                  onError: (error) => toast.error(errorMessageOf(error, '删除失败')),
                  onSuccess: () => onOpenChange(false),
                })
              }}
              variant="danger"
            >
              删除
            </Button>
          </div>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
