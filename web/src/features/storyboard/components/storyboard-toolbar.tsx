import type { ReactNode } from 'react'
import { IconButton } from '@/shared/ui/button'
import { copyWithToast } from './copy-with-toast'
import { ShotGroupSwitcher, type ShotGroupSummary } from './shot-group-switcher'
import { workbenchControl } from './workbench-control'

type StoryboardToolbarProps = {
  groups: readonly ShotGroupSummary[]
  position: number
  status: ReactNode
  onGoShot: (shot: number) => void
  copy: { label: string; text: string; done: string; blocked?: string | undefined }
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
      <div className="storyboard-toolbar-status">{status}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ShotGroupSwitcher groups={groups} onGo={onGoShot} position={position} />
        <IconButton
          className={workbenchControl({ shape: 'icon' })}
          disabled={copy.blocked !== undefined}
          label={copy.label}
          name="copy"
          onClick={() => void copyWithToast(copy.text, copy.done)}
          size="sm"
          tooltip={copy.blocked}
        />
      </div>
    </div>
  )
}
