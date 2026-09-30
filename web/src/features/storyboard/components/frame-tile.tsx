/** 本组图片的格子：缩略图按画幅占位、不裁，下面标 @N，帧计数弹层与正文 `@` 选图共用；末尾的「+」只在 `@` 选图里。 */

import type { ButtonHTMLAttributes } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { BlockedReason } from './blocked-reason'
import { workbenchControl } from './workbench-control'

/** 往选中段添加图片的入口；`blocker` 有值时「+」置灰并说明原因。 */
export type FrameAdd = { blocker: string | undefined; onAdd: () => void }

type TileButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'>

type FrameTileProps = TileButtonProps & {
  frame: number
  url: string
  /** 画幅宽高比，缩略图按它占位。 */
  ratio: number
  /** 舞台上正在看的这张，缩略图描边。 */
  outlined?: boolean
}

/** 选中态认 `aria-current`（帧计数：正在看的）或 `aria-selected`（选图：键盘停在的）。 */
export function FrameTile({
  className,
  frame,
  outlined = false,
  ratio,
  url,
  ...props
}: FrameTileProps) {
  return (
    <button
      className={cn(
        'flex ui-state cursor-pointer flex-col items-center gap-1 rounded-sm p-1 text-label text-on-surface-variant tabular-nums ui-focus',
        'aria-[current=true]:bg-state-active aria-[current=true]:font-medium aria-[current=true]:text-on-surface',
        'aria-selected:bg-state-active aria-selected:font-medium aria-selected:text-on-surface',
        className,
      )}
      type="button"
      {...props}
    >
      <img
        alt=""
        className={cn(
          'block h-16 rounded-xs bg-surface-container object-contain',
          outlined && 'outline-2 outline-offset-1 outline-on-surface',
        )}
        loading="lazy"
        src={url}
        style={{ aspectRatio: ratio }}
      />
      @{frame}
    </button>
  )
}

type FrameAddTileProps = Omit<TileButtonProps, 'onClick'> & {
  blocker: string | undefined
  /** 没被挡住时点按才调。 */
  onAdd: () => void
}

/** 底边与缩略图对齐：外层要在下面留出「@N」那一行的高度（`pb-6`）。 */
export function FrameAddTile({ blocker, className, onAdd, ...props }: FrameAddTileProps) {
  return (
    <BlockedReason reason={blocker}>
      <button
        aria-disabled={blocker === undefined ? undefined : true}
        aria-label="添加图片"
        className={cn(
          workbenchControl({ shape: 'label' }),
          'h-16 w-9 justify-center px-0 aria-selected:outline-2 aria-selected:outline-offset-1 aria-selected:outline-on-surface',
          className,
        )}
        onClick={() => {
          if (blocker === undefined) onAdd()
        }}
        type="button"
        {...props}
      >
        <Icon decorative name="add" size="sm" />
      </button>
    </BlockedReason>
  )
}
