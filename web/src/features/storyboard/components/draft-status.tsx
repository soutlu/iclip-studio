/** 镜头组草稿的保存状态、冲突弹窗与读取提示；分镜页与制作页共用一份，文案不各自分叉。 */

import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { SaveState } from '../use-shots-draft'

export function ReaderNotice({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center">
      <p className="text-body-sm text-on-surface-variant">{text}</p>
    </div>
  )
}

/** 保存状态只看种类与出错原因；分镜页与制作页的草稿各有自己的冲突细节，这里不用。 */
type SaveStatusState =
  { kind: Exclude<SaveState['kind'], 'error'> } | { kind: 'error'; message: string }

type SaveStatusProps = {
  state: SaveStatusState
  hasUnsavedChanges: boolean
  /** 上传已落地但分镜还没保存时，提示要说清图片没丢。 */
  appliedUpload?: boolean | undefined
  onRetry: () => void
}

export function SaveStatus({
  state,
  hasUnsavedChanges,
  appliedUpload = false,
  onRetry,
}: SaveStatusProps) {
  if (state.kind === 'error')
    return (
      <>
        <span className="text-body-sm text-error" role="alert">
          <span>{appliedUpload && hasUnsavedChanges ? '已上传，分镜未保存' : '没存下'}</span>：
          {state.message}
        </span>
        <Button onClick={onRetry} size="md" variant="ghost">
          重试保存
        </Button>
      </>
    )
  if (state.kind === 'conflict')
    return <span className="text-body-sm text-on-surface-faint">有版本冲突待处理</span>
  if (state.kind === 'saving') return <SaveIcon label="保存中…" saving />
  if (hasUnsavedChanges) return <span className="text-body-sm text-on-surface-faint">待保存</span>
  if (state.kind === 'saved') return <SaveIcon label="已保存" />
  return null
}

/** 保存中与已保存只用图标表达；文字给读屏（role=status）和悬停提示。 */
function SaveIcon({ label, saving = false }: { label: string; saving?: boolean }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span
          className="inline-grid size-6 shrink-0 place-items-center text-on-surface-faint"
          role="status"
        >
          {saving ? (
            <Icon className="animate-spin" decorative name="spinner" size="sm" />
          ) : (
            <Icon decorative name="check" size="sm" />
          )}
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </TooltipRoot>
  )
}

export function ConflictDialog({
  state,
  resolve,
}: {
  state: SaveState
  resolve: (choice: 'mine' | 'theirs') => void
}) {
  const conflicts = state.kind === 'conflict' ? state.shots : []
  const aspect = state.kind === 'conflict' ? state.aspect : undefined
  const removed = conflicts.some((conflict) => conflict.theirs === undefined)
  const changed = [
    ...(aspect === undefined ? [] : [`画幅（你选了 ${aspect.mine}，最新是 ${aspect.theirs}）`]),
    ...(conflicts.length === 0 ? [] : [`第 ${conflicts.map((item) => item.index).join('、')} 组`]),
  ].join('，')
  return (
    <DialogRoot
      onOpenChange={(open) => !open && resolve('theirs')}
      open={state.kind === 'conflict'}
    >
      <DialogSurface aria-label="这份分镜有别的改动">
        <DialogHeader closeLabel="关闭（用最新的）" title="这份分镜有别的改动">
          {changed}在你编辑时被更新了。
        </DialogHeader>
        <DialogBody>
          <p className="text-body text-on-surface">
            {removed
              ? '原镜头组已被移除，当前修改不能覆盖到其它镜头组。采用最新版本只会放弃冲突处的修改。'
              : '选择保留你的修改，或采用最新版本；没冲突的草稿会保留。'}
          </p>
        </DialogBody>
        <DialogFooter>
          <span />
          <span className="flex gap-2">
            <Button onClick={() => resolve('theirs')} size="md" variant="ghost">
              用最新的
            </Button>
            <Button disabled={removed} onClick={() => resolve('mine')} size="md">
              留我的
            </Button>
          </span>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
