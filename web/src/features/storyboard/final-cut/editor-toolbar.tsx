import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import { Slider } from '@/shared/ui/slider'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  LOCALES,
  phraseWith,
  SOURCE_LOCALE,
  SOURCE_NAME,
  type Language,
  type LocaleCode,
} from './locales'
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
          aria-label={label}
          aria-pressed={pressed}
          className={cn('wf-tool ui-state ui-focus', pressed === true && 'is-pressed', className)}
          onClick={() => {
            if (blocked === undefined) onClick()
          }}
          type="button"
        >
          <Icon decorative name={icon} size="sm" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" container={tipContainer} side="top">
        {blocked ?? tip}
      </TooltipContent>
    </TooltipRoot>
  )
}

export const Keys = ({ children }: { children: string }) => <kbd className="wf-kbd">{children}</kbd>

/** 时间线上点下去做什么：选择（选中、拖动、裁剪）或切开（剃刀）。 */
export type EditTool = 'select' | 'razor'

const TOOLS: Readonly<Record<EditTool, { name: string; icon: IconName }>> = {
  select: { name: '选择', icon: 'select-tool' },
  razor: { name: '切开', icon: 'split' },
}

const isEditTool = (value: string): value is EditTool => value in TOOLS

type ToolPickerProps = Pick<
  EditorToolbarProps,
  'tool' | 'onTool' | 'onSelectAround' | 'splitBlocked' | 'onSplit'
>

/** 选择工具的下拉：上面是两个工具；下面三项是一次性的命令，点完工具不变。 */
function ToolPicker({ tool, onTool, onSelectAround, splitBlocked, onSplit }: ToolPickerProps) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const current = TOOLS[tool]
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
              aria-label={`选择工具：${current.name}`}
              className="wf-tool wf-tool-picker ui-state ui-focus"
              type="button"
            >
              <Icon decorative name={current.icon} size="sm" />
              <Icon decorative name="expand" size="xs" />
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" side="top">
          选择工具
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="start" side="top">
        <MenuRadioGroup
          onValueChange={(value) => {
            if (isEditTool(value)) onTool(value)
          }}
          value={tool}
        >
          <MenuRadioItem value="select">{TOOLS.select.name}</MenuRadioItem>
          <MenuRadioItem value="razor">{TOOLS.razor.name}</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        {splitBlocked === undefined ? (
          <MenuItem onSelect={onSplit} shortcut={['S']}>
            {SPLIT_LABEL}
          </MenuItem>
        ) : (
          <TooltipRoot>
            <TooltipTrigger asChild>
              <MenuItem aria-disabled onSelect={(event) => event.preventDefault()} shortcut={['S']}>
                {SPLIT_LABEL}
              </MenuItem>
            </TooltipTrigger>
            <TooltipContent side="right">{splitBlocked}</TooltipContent>
          </TooltipRoot>
        )}
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

/** 切开的命令在下拉和片段右键菜单里都叫这个。 */
export const SPLIT_LABEL = '在播放头处切开'

/** 工具条上的语言切换：`current` 是显示着的语言，`present` 是工程里有值表的语言。 */
export type LocaleControls = {
  current: Language
  present: readonly LocaleCode[]
  onSwitch: (code: Language) => void
  /** 加不了语言时的原因（还没有工程）；能加时是 undefined。 */
  addBlocked: string | undefined
  /** 加一种语言并切过去。 */
  onAdd: (code: LocaleCode) => void
}

const localeButtonName = ({ name, tag }: { name: string; tag: string }) => `${name}（${tag}）`

/** 语言切换里的一个按钮：切到哪种语言，按钮上的字、无障碍名和提示。 */
type LocaleButton = { code: Language; tag: string; label: string; tip: string }

const SOURCE_BUTTON: LocaleButton = {
  code: SOURCE_LOCALE,
  tag: SOURCE_NAME,
  label: SOURCE_NAME,
  tip: `切换到${SOURCE_NAME}：预览和字幕显示${SOURCE_NAME}`,
}

/**
 * 语言切换：原文和工程里有的语言各一个按钮（原文写「原文」，别的写语言代码），当前的高亮；最后的「+」点开
 * 列出还没加的语言，选一个加上并切过去，都加了时不显示，加不了时置灰。
 */
function LocaleBar({ current, present, onSwitch, addBlocked, onAdd }: LocaleControls) {
  const buttons: LocaleButton[] = [
    SOURCE_BUTTON,
    ...LOCALES.filter(({ code }) => present.includes(code)).map((locale) => ({
      code: locale.code,
      tag: locale.tag,
      label: localeButtonName(locale),
      tip: `${phraseWith('切换到', locale.code, '：')}${phraseWith('预览和字幕显示', locale.code, '的字')}`,
    })),
  ]
  const addable = LOCALES.filter(({ code }) => !present.includes(code))
  return (
    <div aria-label="语言" className="wf-locales" role="group">
      {buttons.map((button) => (
        <TooltipRoot key={button.label}>
          <TooltipTrigger asChild>
            <button
              aria-label={button.label}
              aria-pressed={button.code === current}
              className="wf-locale ui-state ui-focus"
              onClick={() => onSwitch(button.code)}
              type="button"
            >
              {button.tag}
            </button>
          </TooltipTrigger>
          <TooltipContent className="wf-tip" side="top">
            {button.tip}
          </TooltipContent>
        </TooltipRoot>
      ))}
      {addBlocked !== undefined ? (
        <BlockedAddLocale reason={addBlocked} />
      ) : addable.length === 0 ? null : (
        <AddLocale addable={addable} onAdd={onAdd} />
      )}
    </div>
  )
}

/** 加不了语言时的「+」：置灰，点了只说明原因（和 `Tool` 置灰时一样）。 */
function BlockedAddLocale({ reason }: { reason: string }) {
  const [hint, setHint] = useState(false)
  return (
    <TooltipRoot onOpenChange={setHint} open={hint}>
      <TooltipTrigger
        asChild
        onClick={(event) => {
          event.preventDefault()
          setHint(true)
        }}
      >
        <button
          aria-disabled
          aria-label="添加语言"
          className="wf-locale-add ui-state ui-focus"
          type="button"
        >
          <Icon decorative name="add" size="xs" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="wf-tip" side="top">
        {reason}
      </TooltipContent>
    </TooltipRoot>
  )
}

function AddLocale({
  addable,
  onAdd,
}: {
  addable: readonly (typeof LOCALES)[number][]
  onAdd: (code: LocaleCode) => void
}) {
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
      {/* 和选择工具的下拉一样：菜单开着时不出提示，免得压在向上弹出的菜单底下 */}
      <TooltipRoot onOpenChange={setHint} open={hint && !open}>
        <MenuTrigger asChild>
          <TooltipTrigger asChild>
            <button aria-label="添加语言" className="wf-locale-add ui-state ui-focus" type="button">
              <Icon decorative name="add" size="xs" />
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" side="top">
          添加语言
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="start" side="top">
        {addable.map((locale) => (
          <MenuItem key={locale.code} onSelect={() => onAdd(locale.code)}>
            {localeButtonName(locale)}
          </MenuItem>
        ))}
      </MenuSurface>
    </MenuRoot>
  )
}

type EditorToolbarProps = {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  tool: EditTool
  onTool: (tool: EditTool) => void
  /** 选中播放头左边或右边的片段，替换原有选中。 */
  onSelectAround: (side: 'left' | 'right') => void
  /** 在播放头处切不开选中的片段时的原因；能切时是 undefined。 */
  splitBlocked: string | undefined
  /** 在播放头处切开选中的片段，和按 S 一样。 */
  onSplit: () => void
  /** 有没有选中的片段；没有时「删除」「缩放到选中的片段」置灰。 */
  hasSelection: boolean
  /** 删掉选中的片段，和按 Delete 一样。 */
  onRemove: () => void
  /** 「删除」右边的分离音频钮：分离或合并回视频，和按 ⇧⌘B 一样。 */
  sound: { label: string; blocked: string | undefined; onClick: () => void }
  onZoomToSelection: () => void
  snap: boolean
  onSnap: () => void
  ripple: boolean
  onRipple: () => void
  zoom: Zoom
  /** 「适应宽度」时一秒画多少像素，缩放的档位和滑杆都以它为准。 */
  fitPps: number
  onZoom: (zoom: Zoom) => void
  /** 语言切换，排在吸附、波纹编辑后面。 */
  locales: LocaleControls
  /** 排在右边那组最后的控件（导出）。 */
  actions: ReactNode
}

export function EditorToolbar({
  actions,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  tool,
  onTool,
  onSelectAround,
  splitBlocked,
  onSplit,
  hasSelection,
  onRemove,
  sound,
  onZoomToSelection,
  snap,
  onSnap,
  ripple,
  onRipple,
  zoom,
  fitPps,
  onZoom,
  locales,
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
        <ToolPicker
          onSelectAround={onSelectAround}
          onSplit={onSplit}
          onTool={onTool}
          splitBlocked={splitBlocked}
          tool={tool}
        />
        <Tool
          blocked={hasSelection ? undefined : '尚未选中片段，无法删除；请先选中片段'}
          icon="delete"
          label="删除"
          onClick={onRemove}
          shortcuts="Delete"
          tip={
            <>
              删除
              <Keys>Delete</Keys>
            </>
          }
        />
        <Tool
          blocked={sound.blocked}
          icon="waveform"
          label={sound.label}
          onClick={sound.onClick}
          shortcuts="Shift+Meta+B"
          tip={
            <>
              {sound.label}
              <Keys>⇧⌘B</Keys>
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
              ? '吸附已开启：拖动和裁剪时贴靠其他片段的两端、播放头和配乐的节拍'
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
        <span aria-hidden="true" className="wf-divider" />
        <LocaleBar {...locales} />
      </div>
      <div className="wf-toolbar-group">
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
        <Tool icon="fit" label="适应宽度" onClick={() => onZoom(FIT_ZOOM)} tip="适应宽度" />
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          icon="zoom-out"
          label="缩小时间线"
          onClick={() => onZoom(nextZoom('out', zoom, fitPps))}
          tip="缩小时间线"
        />
        <Slider
          className="mx-1 w-17 flex-none"
          label="时间线缩放"
          max={100}
          min={0}
          onChange={(at) => onZoom(sliderToZoom(at, fitPps))}
          value={zoomToSlider(zoom, fitPps)}
          valueText={zoomLabel(zoom, fitPps)}
        />
        <Tool
          icon="zoom"
          label="放大时间线"
          onClick={() => onZoom(nextZoom('in', zoom, fitPps))}
          tip="放大时间线"
        />
        <span className="wf-zoom-readout">{zoomLabel(zoom, fitPps)}</span>
        {actions}
      </div>
    </div>
  )
}
