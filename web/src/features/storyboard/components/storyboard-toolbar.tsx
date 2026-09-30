/** 分镜工作台顶栏：保存状态，镜头组切换（上一组、下一组，点中间打开全部镜头组），以及复制整组完整提示词。 */

import type { ReactNode } from 'react'
import { IconButton } from '@/shared/ui/button'
import type { ReaderSheet } from '../shot-content'
import { copyWithToast } from './copy-with-toast'
import { ShotGroupSwitcher } from './shot-group-switcher'
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
  /** 切到第几组；与 ↑↓ 键同一条路径。 */
  onGoShot: (shot: number) => void
  /** 复制按钮拷走的整组完整提示词。 */
  fullPrompt: string
}

export function StoryboardToolbar({
  fullPrompt,
  onGoShot,
  onOpenSheet,
  position,
  sheet,
  status,
  total,
}: StoryboardToolbarProps) {
  return (
    <div aria-label="分镜工具栏" className="storyboard-toolbar" role="group">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{status}</div>
      <ShotGroupSwitcher
        expanded={sheet === 'all'}
        onGo={onGoShot}
        onOpenAll={(trigger) => onOpenSheet('all', trigger)}
        position={position}
        total={total}
      />
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
