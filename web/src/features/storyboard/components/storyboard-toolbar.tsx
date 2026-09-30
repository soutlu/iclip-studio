/** 分镜工作台顶栏：组号（点开全部镜头组）、保存状态、生成记录入口，以及复制整组完整提示词。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { Button, IconButton } from '@/shared/ui/button'
import type { ReaderSheet } from '../shot-content'
import { copyWithToast } from './copy-with-toast'

type StoryboardToolbarProps = {
  /** 当前组在全部组里排第几，从 1 起。 */
  position: number
  total: number
  /** 保存状态，由调用方渲染好放进来。 */
  status: ReactNode
  /** 当前盖在分镜上的那一层，对应入口标成展开。 */
  sheet: ReaderSheet | undefined
  onOpenSheet: (sheet: ReaderSheet, trigger: HTMLElement) => void
  /** 本组还在跑的出片数，挂在生成记录入口上。 */
  activeCount: number
  /** 复制按钮拷走的整组完整提示词。 */
  fullPrompt: string
}

export function StoryboardToolbar({
  activeCount,
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
        className="inline-flex h-8 shrink-0 ui-state cursor-pointer items-center gap-1 rounded-sm bg-surface-container pr-2 pl-2.5 text-body text-on-surface tabular-nums ui-focus"
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
      <Button
        aria-expanded={sheet === 'records'}
        aria-label="生成记录"
        className="shrink-0 border-[0.5px] border-chat-hairline bg-background px-3 text-body text-on-surface"
        leadingIcon="history"
        onClick={(event) => onOpenSheet('records', event.currentTarget)}
        size="md"
        variant="outlined"
      >
        生成记录
        {activeCount > 0 ? <span className="ml-1 text-primary">生成中 {activeCount}</span> : null}
      </Button>
      <IconButton
        className="size-8 shrink-0 rounded-sm bg-surface-container text-on-surface"
        label="复制完整提示词"
        name="copy"
        onClick={() => void copyWithToast(fullPrompt, '已复制完整提示词')}
        size="sm"
        title="复制完整提示词"
      />
    </div>
  )
}
