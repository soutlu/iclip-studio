import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
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
import { SOUND_ACTION_LOOK } from './sound-pair'
import { FIT_ZOOM, sliderToZoom, zoomLabel, zoomToSlider, type Zoom } from './timeline-scale'

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

const TOOLS: Readonly<
  Record<EditTool, { name: string; icon: IconName; keys: string; className: string }>
> = {
  select: { name: '选择工具', icon: 'final-cut-select', keys: 'V', className: 'wf-tool-select' },
  razor: { name: '切开工具', icon: 'final-cut-split', keys: 'B', className: 'wf-tool-razor' },
}

/** 选择、切开两个工具排成一条分段，当前的那段浮起。 */
function ToolSwitch({ tool, onTool }: Pick<EditorToolbarProps, 'tool' | 'onTool'>) {
  return (
    <div aria-label="编辑工具" className="wf-seg" role="group">
      {(['select', 'razor'] as const).map((each) => (
        <Tool
          className={cn('wf-seg-item', TOOLS[each].className)}
          icon={TOOLS[each].icon}
          key={each}
          label={TOOLS[each].name}
          onClick={() => onTool(each)}
          pressed={tool === each}
          shortcuts={TOOLS[each].keys}
          tip={
            <>
              {TOOLS[each].name}
              <Keys>{TOOLS[each].keys}</Keys>
            </>
          }
        />
      ))}
    </div>
  )
}

type CommandsProps = Pick<EditorToolbarProps, 'onSelectAround' | 'splitBlocked' | 'onSplit'>

/** 分段右边的小箭头：三条一次性的命令（在播放头处切开、选中播放头左边或右边的片段），点完工具不变。 */
function EditCommands({ onSelectAround, splitBlocked, onSplit }: CommandsProps) {
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
              aria-label={COMMANDS_LABEL}
              className="wf-tool wf-tool-commands ui-state ui-focus"
              type="button"
            >
              <Icon decorative name="final-cut-expand" size="xs" />
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" side="top">
          {COMMANDS_LABEL}
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="start" className="wf-menu" side="top">
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

const COMMANDS_LABEL = '更多剪辑命令'

/** 切开的命令在下拉和片段右键菜单里都叫这个。 */
export const SPLIT_LABEL = '在播放头处切开'

/** 工具条上的语言切换：`current` 是显示着的语言，`present` 是工程里有值表的语言。 */
export type LocaleControls = {
  current: Language
  present: readonly LocaleCode[]
  onSwitch: (code: Language) => void
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
 * 语言切换：原文和工程里有的语言各一个按钮（原文写「原文」，别的写语言代码，无障碍名是语言的名字加代码），
 * 当前的高亮；最后的「+」点开列出还没加的语言，选一个加上并切过去，都加了时不显示。工具条上的
 * （`inPanel` 不给）菜单往上弹；「字幕」页签顶部的（`inPanel`）是一排小块，菜单往下弹。两处切换、添加的是
 * 同一份 `LocaleControls`。
 */
export function LocaleBar({
  current,
  present,
  onSwitch,
  onAdd,
  inPanel = false,
}: LocaleControls & { inPanel?: boolean }) {
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
  const side = inPanel ? 'bottom' : 'top'
  return (
    // 侧栏里的这一组不能叫「语言」：按名字找工具条上那一组时会把它也找到
    <div
      aria-label={inPanel ? '原文与译文' : '语言'}
      className={cn('wf-locales', inPanel && 'is-panel')}
      role="group"
    >
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
          <TooltipContent className="wf-tip" side={side}>
            {button.tip}
          </TooltipContent>
        </TooltipRoot>
      ))}
      {addable.length === 0 ? null : <AddLocale addable={addable} onAdd={onAdd} side={side} />}
    </div>
  )
}

/** 菜单和提示往哪边弹。 */
type PopSide = 'top' | 'bottom'

function AddLocale({
  addable,
  onAdd,
  side,
}: {
  addable: readonly (typeof LOCALES)[number][]
  onAdd: (code: LocaleCode) => void
  side: PopSide
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
              <Icon decorative name="final-cut-add" size="xs" />
            </button>
          </TooltipTrigger>
        </MenuTrigger>
        <TooltipContent className="wf-tip" side={side}>
          添加语言
        </TooltipContent>
      </TooltipRoot>
      <MenuSurface align="start" className="wf-menu" side={side}>
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
  sound: { kind: 'detach' | 'merge'; blocked: string | undefined; onClick: () => void }
  onZoomToSelection: () => void
  snap: boolean
  onSnap: () => void
  ripple: boolean
  onRipple: () => void
  zoom: Zoom
  /** 「适应宽度」时一秒画多少像素，缩放的档位和滑杆都以它为准。 */
  fitPps: number
  onZoom: (zoom: Zoom) => void
  /** 语言切换，排在右边那组的最前面。 */
  locales: LocaleControls
}

export function EditorToolbar({
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
          icon="final-cut-undo"
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
          icon="final-cut-redo"
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
        <ToolSwitch onTool={onTool} tool={tool} />
        <EditCommands
          onSelectAround={onSelectAround}
          onSplit={onSplit}
          splitBlocked={splitBlocked}
        />
        <Tool
          blocked={hasSelection ? undefined : '尚未选中片段，无法删除；请先选中片段'}
          className="is-danger"
          icon="final-cut-delete"
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
        <span aria-hidden="true" className="wf-divider" />
        <Tool
          blocked={sound.blocked}
          className="wf-tool-detach"
          icon={SOUND_ACTION_LOOK[sound.kind].icon}
          label={SOUND_ACTION_LOOK[sound.kind].label}
          onClick={sound.onClick}
          shortcuts="Shift+Meta+B"
          tip={
            <>
              {SOUND_ACTION_LOOK[sound.kind].label}
              <Keys>⇧⌘B</Keys>
            </>
          }
        />
        <Tool
          className="wf-tool-snap"
          icon="final-cut-snap"
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
          className="wf-tool-ripple"
          icon="final-cut-ripple"
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
        <LocaleBar {...locales} />
        <span aria-hidden="true" className="wf-divider" />
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
        <Tool
          icon="final-cut-fit"
          label="适应宽度"
          onClick={() => onZoom(FIT_ZOOM)}
          tip="适应宽度：整条时间线排满"
        />
        <Slider
          className="mx-1 w-19.5 flex-none"
          label="时间线缩放"
          max={100}
          min={0}
          onChange={(at) => onZoom(sliderToZoom(at, fitPps))}
          value={zoomToSlider(zoom, fitPps)}
          valueText={zoomLabel(zoom, fitPps)}
        />
      </div>
    </div>
  )
}
