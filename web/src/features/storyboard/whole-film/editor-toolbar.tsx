import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { timeLabel } from '../editing/time-label'

type ToolProps = {
  icon: IconName
  label: string
  tip: ReactNode
  blocked?: string | undefined
  onClick: () => void
  showLabel?: boolean
  shortcuts?: string
  className?: string
}

function Tool({
  icon,
  label,
  tip,
  blocked,
  onClick,
  showLabel = false,
  shortcuts,
  className,
}: ToolProps) {
  const [hint, setHint] = useState(false)
  return (
    <TooltipRoot onOpenChange={setHint} open={hint}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          if (blocked === undefined) return
          event.preventDefault()
          setHint(true)
        }}
      >
        <button
          aria-disabled={blocked === undefined ? undefined : true}
          aria-keyshortcuts={shortcuts}
          aria-label={showLabel ? undefined : label}
          className={cn('wf-tool ui-state ui-focus', showLabel && 'has-label', className)}
          onClick={() => {
            if (blocked === undefined) onClick()
          }}
          type="button"
        >
          <Icon decorative name={icon} size="sm" />
          {showLabel ? <span>{label}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {blocked ?? tip}
      </TooltipContent>
    </TooltipRoot>
  )
}

const Keys = ({ children }: { children: string }) => <kbd className="wf-kbd">{children}</kbd>

type EditorToolbarProps = {
  playheadMs: number
  totalMs: number
  playBlocked: string | undefined
  playing: boolean
  onPlay: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  insertBlocked: string | undefined
  onInsert: () => void
}

export function EditorToolbar({
  playheadMs,
  totalMs,
  playBlocked,
  playing,
  onPlay,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  insertBlocked,
  onInsert,
}: EditorToolbarProps) {
  const playLabel = playing ? '暂停' : '播放'
  return (
    <div aria-label="剪辑工具" className="wf-toolbar" role="toolbar">
      <div className="wf-toolbar-group">
        <Tool
          blocked={playBlocked}
          className="wf-play"
          icon={playing ? 'pause' : 'play'}
          label={playLabel}
          onClick={onPlay}
          shortcuts="Space"
          tip={
            <>
              {playLabel}
              <Keys>空格</Keys>
            </>
          }
        />
        <span className="wf-clock">
          {timeLabel(playheadMs / 1000)} <span>/ {timeLabel(totalMs / 1000)}</span>
        </span>
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          blocked={canUndo ? undefined : '没有可撤销的操作'}
          icon="undo"
          label="撤销"
          onClick={onUndo}
          shortcuts="Meta+Z"
          tip={
            <>
              撤销
              <Keys>⌘Z</Keys>
            </>
          }
        />
        <Tool
          blocked={canRedo ? undefined : '没有可重做的操作'}
          icon="redo"
          label="重做"
          onClick={onRedo}
          shortcuts="Shift+Meta+Z"
          tip={
            <>
              重做
              <Keys>⇧⌘Z</Keys>
            </>
          }
        />
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          blocked={insertBlocked}
          icon="insert"
          label="加入成片"
          onClick={onInsert}
          shortcuts="Enter"
          showLabel
          tip={
            <>
              把选中的范围接在成片末尾
              <Keys>↵</Keys>
            </>
          }
        />
      </div>
    </div>
  )
}
