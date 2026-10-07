/** 分镜工作台顶栏：保存状态，镜头组切换（上一组、下一组，点中间展开镜头组列表），以及复制整组的字。
 * 分镜页与制作页共用，各自给镜头组摘要和要复制的字。 */

import type { ReactNode } from 'react'
import { IconButton } from '@/shared/ui/button'
import { copyWithToast } from './copy-with-toast'
import { ShotGroupSwitcher, type ShotGroupSummary } from './shot-group-switcher'
import { workbenchControl } from './workbench-control'

type StoryboardToolbarProps = {
  groups: readonly ShotGroupSummary[]
  /** 当前组在全部组里排第几，从 1 起。 */
  position: number
  /** 保存状态，由调用方渲染好放进来。 */
  status: ReactNode
  /** 切到第几组；与 ↑↓ 键同一条路径。 */
  onGoShot: (shot: number) => void
  /** 复制按钮：按钮名、拷走的字与拷好后的提示。 */
  copy: { label: string; text: string; done: string }
}

export function StoryboardToolbar({
  copy,
  groups,
  onGoShot,
  position,
  status,
}: StoryboardToolbarProps) {
  return (
    <div aria-label="分镜工具栏" className="storyboard-toolbar" role="group">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{status}</div>
      <ShotGroupSwitcher groups={groups} onGo={onGoShot} position={position} />
      <IconButton
        className={workbenchControl({ shape: 'icon' })}
        label={copy.label}
        name="copy"
        onClick={() => void copyWithToast(copy.text, copy.done)}
        size="sm"
      />
    </div>
  )
}
