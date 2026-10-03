/** 分镜工作台顶栏：保存状态，镜头组切换（上一组、下一组，点中间展开镜头组列表），以及复制整组完整提示词。 */

import type { ReactNode } from 'react'
import { IconButton } from '@/shared/ui/button'
import type { Shot } from '../shot-document'
import { copyWithToast } from './copy-with-toast'
import { ShotGroupSwitcher } from './shot-group-switcher'
import { workbenchControl } from './workbench-control'

type StoryboardToolbarProps = {
  shots: readonly Shot[]
  /** 分镜画幅，镜头组列表的缩略图按它的比例。 */
  aspectRatio: string
  /** 当前组在全部组里排第几，从 1 起。 */
  position: number
  /** 保存状态，由调用方渲染好放进来。 */
  status: ReactNode
  /** 切到第几组；与 ↑↓ 键同一条路径。 */
  onGoShot: (shot: number) => void
  /** 复制按钮拷走的整组完整提示词。 */
  fullPrompt: string
}

export function StoryboardToolbar({
  aspectRatio,
  fullPrompt,
  onGoShot,
  position,
  shots,
  status,
}: StoryboardToolbarProps) {
  return (
    <div aria-label="分镜工具栏" className="storyboard-toolbar" role="group">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{status}</div>
      <ShotGroupSwitcher
        aspectRatio={aspectRatio}
        onGo={onGoShot}
        position={position}
        shots={shots}
      />
      <IconButton
        className={workbenchControl({ shape: 'icon' })}
        label="复制完整提示词"
        name="copy"
        onClick={() => void copyWithToast(fullPrompt, '已复制完整提示词')}
        size="sm"
      />
    </div>
  )
}
