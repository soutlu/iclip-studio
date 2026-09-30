/** 分镜工作台顶栏：组号（点开全部镜头组）、保存状态，以及复制整组完整提示词。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import type { ReaderSheet } from '../shot-content'
import { copyWithToast } from './copy-with-toast'
import { workbenchControl } from './workbench-control'

type StoryboardToolbarProps = {
  /** 当前组在全部组里排第几，从 1 起。 */
  position: number
  total: number
  /** 保存状态，由调用方渲染好放进来。 */
  status: ReactNode
  /** 当前盖在分镜上的那一层，对应入口标成展开。 */
  sheet: ReaderSheet | undefined
  onOpenSheet: (sheet: ReaderSheet, trigger: HTMLElement) => void
  /** 复制按钮拷走的整组完整提示词。 */
  fullPrompt: string
}

export function StoryboardToolbar({
  fullPrompt,
  onOpenSheet,
  position,
  sheet,
  status,
  total,
}: StoryboardToolbarProps) {
  return (
    <div aria-label="分镜工具栏" className="storyboard-toolbar" role="group">
      <button
        aria-expanded={sheet === 'all'}
        aria-label={`镜头组 ${position} / ${total}，打开全部镜头组`}
        className={cn(workbenchControl({ shape: 'label' }), 'pr-2 text-body')}
        onClick={(event) => onOpenSheet('all', event.currentTarget)}
        title="全部镜头组"
        type="button"
      >
        <Icon decorative name="grid" size="sm" />
        <span className="ml-0.5 font-semibold">{position}</span>
        <span className="text-on-surface-faint">/ {total}</span>
        <Icon decorative name="expand" size="xs" />
      </button>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{status}</div>
      <IconButton
        className={workbenchControl({ shape: 'icon' })}
        label="复制完整提示词"
        name="copy"
        onClick={() => void copyWithToast(fullPrompt, '已复制完整提示词')}
        size="sm"
        title="复制完整提示词"
      />
    </div>
  )
}
