import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { copyWithToast } from './copy-with-toast'
import { ShotGroupSwitcher, type ShotGroupSummary } from './shot-group-switcher'
import { workbenchControl } from './workbench-control'

type StoryboardToolbarProps = {
  groups: readonly ShotGroupSummary[]
  position: number
  status: ReactNode
  onGoShot: (shot: number) => void
  copy: { label: string; text: string; done: string; blocked?: string | undefined }
  onWholeFilm: (() => void) | undefined
}

export function StoryboardToolbar({
  copy,
  groups,
  onGoShot,
  onWholeFilm,
  position,
  status,
}: StoryboardToolbarProps) {
  return (
    <div aria-label="分镜工具栏" className="storyboard-toolbar" role="group">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{status}</div>
      {onWholeFilm === undefined ? null : (
        <TooltipRoot>
          <TooltipTrigger asChild>
            <button
              className={cn(workbenchControl({ shape: 'label' }), 'gap-1.5')}
              onClick={onWholeFilm}
              type="button"
            >
              <Icon decorative name="video-type" size="sm" />
              成片
            </button>
          </TooltipTrigger>
          <TooltipContent>把各镜头组的素材片剪成成片</TooltipContent>
        </TooltipRoot>
      )}
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
  )
}
