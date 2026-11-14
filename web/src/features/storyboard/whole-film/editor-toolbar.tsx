import { Slider } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
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
  /** 提示挂到哪个元素里，见 `TooltipContent` 的 `container`。 */
  tipContainer?: HTMLElement | null
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
  tipContainer = null,
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
      <TooltipContent className="wf-tip" container={tipContainer} side="top">
        {blocked ?? tip}
      </TooltipContent>
    </TooltipRoot>
  )
}

export const Keys = ({ children }: { children: string }) => <kbd className="wf-kbd">{children}</kbd>

/** 选择工具的下拉：现在只有「选择」一个工具；另两项是一次性的命令，点完工具不变。 */
function ToolPicker({ onSelectAround }: { onSelectAround: (side: 'left' | 'right') => void }) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  return (
    <MenuRoot
      onOpenChange={(next) => {
        setOpen(next)
        setHint(false)
      }}
      open={open}
    >
      {/* 点开后指针还停在按钮上，提示会重新出现、压在向上弹出的菜单底下 */}
      <TooltipRoot onOpenChange={setHint} open={hint && !open}>
        <MenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              aria-label="选择工具：选择"
              className="wf-tool wf-tool-picker ui-state ui-focus"
              type="button"
            >
              <Icon decorative name="select-tool" size="sm" />
              <Icon decorative name="expand" size="xs" />
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" side="top">
          选择工具
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="start" side="top">
        <MenuRadioGroup value="select">
          <MenuRadioItem value="select">选择</MenuRadioItem>
        </MenuRadioGroup>
        <MenuItem onSelect={() => onSelectAround('left')} shortcut={['[']}>
          选中播放头左边的片段
        </MenuItem>
        <MenuItem onSelect={() => onSelectAround('right')} shortcut={[']']}>
          选中播放头右边的片段
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

type EditorToolbarProps = {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** 选中播放头左边或右边的片段，替换原有选中。 */
  onSelectAround: (side: 'left' | 'right') => void
  /** 有没有选中的片段；没有时「缩放到选中的片段」置灰。 */
  hasSelection: boolean
  onZoomToSelection: () => void
  snap: boolean
  onSnap: () => void
  ripple: boolean
  onRipple: () => void
  /** 片段上要不要显示画面缩略图。 */
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
  onSelectAround,
  hasSelection,
  onZoomToSelection,
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
          blocked={canUndo ? undefined : '暂无可撤销的操作'}
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
          blocked={canRedo ? undefined : '暂无可重做的操作'}
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
        <ToolPicker onSelectAround={onSelectAround} />
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          icon="snap"
          label="吸附"
          onClick={onSnap}
          pressed={snap}
          tip={
            snap
              ? '吸附已开启：拖动和裁剪时贴靠其他片段的两端和播放头'
              : '吸附已关闭：片段停在拖到的位置'
          }
        />
        <Tool
          icon="ripple"
          label="波纹编辑"
          onClick={onRipple}
          pressed={ripple}
          tip={
            ripple
              ? '波纹编辑已开启：删除第一行的片段后，后面的片段自动前移补位'
              : '波纹编辑已关闭：删除片段后保留空档'
          }
        />
      </div>
      <div className="wf-toolbar-group">
        <Tool
          icon="image"
          label="显示缩略图"
          onClick={onThumbnails}
          pressed={thumbnails}
          tip={thumbnails ? '缩略图已开启：片段上显示画面' : '缩略图已关闭：片段上仅显示名称和声音'}
        />
        <Tool
          blocked={hasSelection ? undefined : '尚未选中片段，无法缩放；请先选中一个片段'}
          icon="zoom-selection"
          label="缩放到选中的片段"
          onClick={onZoomToSelection}
          shortcuts="Z"
          tip={
            <>
              缩放到选中的片段
              <Keys>Z</Keys>
            </>
          }
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
