import { Slider } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  FIT_ZOOM,
  nextZoom,
  sliderToZoom,
  zoomLabel,
  zoomToSlider,
  type Zoom,
} from './timeline-scale'

type ToolProps = {
  icon: IconName
  label: string
  tip: ReactNode
  blocked?: string | undefined
  /** 开关类按钮现在是开还是关；不是开关就不给。 */
  pressed?: boolean
  onClick: () => void
  showLabel?: boolean
  shortcuts?: string
  className?: string
}

export function Tool({
  icon,
  label,
  tip,
  blocked,
  pressed,
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
          aria-pressed={pressed}
          className={cn(
            'wf-tool ui-state ui-focus',
            showLabel && 'has-label',
            pressed === true && 'is-pressed',
            className,
          )}
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

export const Keys = ({ children }: { children: string }) => <kbd className="wf-kbd">{children}</kbd>

type EditorToolbarProps = {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  snap: boolean
  onSnap: () => void
  ripple: boolean
  onRipple: () => void
  /** 块上要不要显示画面缩略图。 */
  thumbnails: boolean
  onThumbnails: () => void
  zoom: Zoom
  /** 「适应宽度」时一秒画多少像素，缩放的档位和滑杆都以它为准。 */
  fitPps: number
  onZoom: (zoom: Zoom) => void
}

export function EditorToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  snap,
  onSnap,
  ripple,
  onRipple,
  thumbnails,
  onThumbnails,
  zoom,
  fitPps,
  onZoom,
}: EditorToolbarProps) {
  return (
    <div aria-label="剪辑工具" className="wf-toolbar" role="toolbar">
      <div className="wf-toolbar-group">
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
          icon="snap"
          label="吸附"
          onClick={onSnap}
          pressed={snap}
          tip={
            snap
              ? '吸附开着：拖动和裁剪时会吸到别的块的两端和播放头上'
              : '吸附关着：拖到哪里就是哪里'
          }
        />
        <Tool
          icon="ripple"
          label="波纹编辑"
          onClick={onRipple}
          pressed={ripple}
          tip={
            ripple
              ? '波纹编辑开着：删掉第一行的块，后面的自动往前补上'
              : '波纹编辑关着：删掉块以后留下空档'
          }
        />
      </div>
      <div className="wf-toolbar-group">
        <Tool
          icon="image"
          label="显示缩略图"
          onClick={onThumbnails}
          pressed={thumbnails}
          tip={thumbnails ? '缩略图开着：块上显示画面' : '缩略图关着：块上只有名字和声音'}
        />
        <span aria-hidden="true" className="wf-divider" />
        <Tool icon="fit" label="适应宽度" onClick={() => onZoom(FIT_ZOOM)} tip="适应宽度" />
        <Tool
          icon="zoom-out"
          label="缩小时间线"
          onClick={() => onZoom(nextZoom('out', zoom, fitPps))}
          tip="缩小时间线"
        />
        <Slider.Root
          className="wf-zoom"
          max={100}
          onValueChange={([at]) => {
            if (at !== undefined) onZoom(sliderToZoom(at, fitPps))
          }}
          step={1}
          value={[zoomToSlider(zoom, fitPps)]}
        >
          <Slider.Track className="wf-zoom-track" />
          <Slider.Thumb
            aria-label="时间线缩放"
            aria-valuetext={zoomLabel(zoom, fitPps)}
            className="wf-zoom-thumb ui-focus"
          />
        </Slider.Root>
        <Tool
          icon="zoom"
          label="放大时间线"
          onClick={() => onZoom(nextZoom('in', zoom, fitPps))}
          tip="放大时间线"
        />
        <span className="wf-zoom-readout">{zoomLabel(zoom, fitPps)}</span>
      </div>
    </div>
  )
}
