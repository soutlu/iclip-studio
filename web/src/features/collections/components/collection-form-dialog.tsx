import { useRef, useState, type RefObject } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'
import { useSaveCollection, type Collection } from '../collections.api'

const MAX_NAME_CHARS = 200
// 离上限还剩这么多字时才显示计数，平时不占视线。
const COUNT_HINT_FROM = MAX_NAME_CHARS - 20

type CollectionFormDialogProps = {
  /** 预填的名字，如关联合集搜索框里输入的词。 */
  initialName?: string
  onOpenChange: (open: boolean) => void
  /** 返回服务端合集，供调用方选中它并刷新侧栏拓扑。 */
  onSaved: (collection: Collection) => void
  open: boolean
}

/** 新建合集的弹窗，供没有可原位编辑的列表行的入口使用（如首页关联合集）；侧栏在行内新建。 */
export function CollectionFormDialog({
  initialName = '',
  onOpenChange,
  onSaved,
  open,
}: CollectionFormDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        aria-label="新建合集"
        // 打开时焦点交给名称框，而不是表头的关闭按钮。
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title="新建合集"
        />
        {open ? (
          <CollectionForm
            initialName={initialName}
            inputRef={inputRef}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function CollectionForm({
  initialName,
  inputRef,
  onOpenChange,
  onSaved,
}: Omit<CollectionFormDialogProps, 'open'> & { inputRef: RefObject<HTMLInputElement | null> }) {
  const [name, setName] = useState(initialName ?? '')
  const saveMutation = useSaveCollection((saved) => {
    toast.success('已新建合集')
    onSaved(saved)
    onOpenChange(false)
  })

  const trimmed = name.trim()
  const submit = () => {
    if (!trimmed || saveMutation.isPending) return
    saveMutation.mutate(
      { name: trimmed },
      {
        onError: (error) => {
          toast.error(errorMessageOf(error, '保存失败，请重试'))
        },
      },
    )
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-1 px-6 pt-2.5 pb-6">
        <Input
          aria-label="合集名称"
          className="h-(--control-height-sm) rounded-sm border-border"
          maxLength={MAX_NAME_CHARS}
          disabled={saveMutation.isPending}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          placeholder="请输入合集名称"
          ref={inputRef}
          value={name}
        />
        {name.length >= COUNT_HINT_FROM && (
          <span
            className={cn(
              'self-end text-caption',
              name.length >= MAX_NAME_CHARS ? 'text-error' : 'text-on-surface-variant',
            )}
          >
            {name.length}/{MAX_NAME_CHARS}
          </span>
        )}
      </DialogBody>
      <DialogFooter>
        <span />
        <div className="flex gap-2">
          <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
            取消
          </Button>
          <Button
            className="min-w-[74px]"
            disabled={!trimmed}
            loading={saveMutation.isPending}
            onClick={submit}
          >
            保存
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
