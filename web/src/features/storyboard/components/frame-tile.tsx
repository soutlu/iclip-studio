import type { ButtonHTMLAttributes } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { workbenchControl } from './workbench-control'

export type FrameAdd = () => void

type TileButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'>

type FrameTileProps = TileButtonProps & {
  frame: number
  url: string | null
  ratio: number
  outlined?: boolean
}

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
      {url === null ? (
        <span
          aria-hidden
          className="block h-16 rounded-xs bg-surface-container"
          style={{ aspectRatio: ratio }}
        />
      ) : (
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
      )}
      @{frame}
    </button>
  )
}

export function FrameAddTile({ className, ...props }: TileButtonProps) {
  return (
    <button
      aria-label="添加图片"
      className={cn(
        workbenchControl({ shape: 'label' }),
        'h-16 w-9 justify-center px-0 aria-selected:outline-2 aria-selected:outline-offset-1 aria-selected:outline-on-surface',
        className,
      )}
      type="button"
      {...props}
    >
      <Icon decorative name="add" size="sm" />
    </button>
  )
}
