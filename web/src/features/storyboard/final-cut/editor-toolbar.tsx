import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { Slider } from '@/shared/ui/slider'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { useScrollFade } from '../components/use-scroll-fade'
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
  /** 开关类按钮的当前激活状态；非开关按钮省略。 */
  pressed?: boolean
  onClick: () => void
  shortcuts?: string
  className?: string
  /** 提示浮层的挂载容器，透传至 `TooltipContent` 的 `container`。 */
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

/** 时间线编辑工具模式：选择（点选、拖拽与裁剪）或切开（剃刀）。 */
export type EditTool = 'select' | 'razor'

const TOOLS: Readonly<Record<EditTool, { name: string; icon: IconName; keys: string }>> = {
  select: { name: '选择工具', icon: 'final-cut-select', keys: 'V' },
  razor: { name: '切开工具', icon: 'final-cut-split', keys: 'B' },
}

/** 选择与切开工具组成的分段（共用分段，格子收成图标宽），当前工具浮起；提示里写快捷键。 */
function ToolSwitch({ tool, onTool }: Pick<EditorToolbarProps, 'tool' | 'onTool'>) {
  return (
    <ChipGroup
      aria-label="编辑工具"
      className="auto-cols-auto"
      onValueChange={(value) => {
        if (value === 'select' || value === 'razor') onTool(value)
      }}
      type="single"
      value={tool}
      variant="segmented"
    >
      {(['select', 'razor'] as const).map((each) => (
        <TooltipRoot key={each}>
          <TooltipTrigger asChild>
            <FilterChip
              aria-keyshortcuts={TOOLS[each].keys}
              aria-label={TOOLS[each].name}
              className="w-7.5 px-0"
              value={each}
              variant="segmented"
            >
              <Icon decorative name={TOOLS[each].icon} size="sm" />
            </FilterChip>
          </TooltipTrigger>
          <TooltipContent className="wf-tip" side="top">
            {TOOLS[each].name}
            <Keys>{TOOLS[each].keys}</Keys>
          </TooltipContent>
        </TooltipRoot>
      ))}
    </ChipGroup>
  )
}

type CommandsProps = Pick<EditorToolbarProps, 'onSelectAround' | 'splitBlocked' | 'onSplit'>

/** 分段控件右侧的下拉菜单：提供一次性剪辑命令（在播放头处切开、选中播放头左/右侧片段），执行后不切换当前工具。 */
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
      {/* 菜单展开时若指针仍停留在触发按钮上，禁用 Tooltip 避免提示压在向上弹出的菜单下方 */}
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

/** 「在播放头处切开」命令名称，下拉菜单与片段右键菜单共用。 */
export const SPLIT_LABEL = '在播放头处切开'

/** 工具条语言切换状态与操作：`current` 为当前展示语言，`present` 为工程内已存在值表的语言列表。 */
export type LocaleControls = {
  current: Language
  present: readonly LocaleCode[]
  onSwitch: (code: Language) => void
  /** 新增一种语言值表并切换至该语言。 */
  onAdd: (code: LocaleCode) => void
}

const localeButtonName = ({ name, tag }: { name: string; tag: string }) => `${name}（${tag}）`

/** 语言切换栏单个按钮配置：目标语言、展示代码、无障碍名称与悬停提示。 */
type LocaleButton = { code: Language; tag: string; label: string; tip: string }

const SOURCE_BUTTON: LocaleButton = {
  code: SOURCE_LOCALE,
  tag: SOURCE_NAME,
  label: SOURCE_NAME,
  tip: `切换到${SOURCE_NAME}：预览和字幕显示${SOURCE_NAME}`,
}

/**
 * 语言切换栏：原文及工程内已有值表的语言平铺成一个分段（原文显示「原文」，其余显示语言代码，无障碍名称为完整语言名与代码），
 * 当前项浮起；分段放不下时横向滚动、能滚的一侧渐隐，当前语言自动滚进看得见的地方。分段右边的「+」菜单列出尚未添加的语言，
 * 选定后新建并切换，全部添加后隐藏。底部工具条（默认）的菜单和提示向上弹，「字幕」页签顶部（`inPanel`）的向下弹；
 * 两处同一个样子，共享同一份 `LocaleControls`。
 */
export function LocaleBar({
  current,
  present,
  onSwitch,
  onAdd,
  inPanel = false,
}: LocaleControls & { inPanel?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { fade, width } = useScrollFade(scrollRef)
  // 当前语言被挡在滚动区外面时滚过去（换了语言、加了语言、滚动区变窄时）；只挪这一层，不带着外面的页面一起滚
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const shown = scroller?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (scroller === null || shown === null || shown === undefined) return
    const left = shown.offsetLeft - LOCALE_SCROLL_MARGIN
    const right = shown.offsetLeft + shown.offsetWidth + LOCALE_SCROLL_MARGIN
    if (left < scroller.scrollLeft) scroller.scrollLeft = left
    else if (right > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = right - scroller.clientWidth
  }, [current, present, width])
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
    <div className="wf-locales">
      <div className="wf-locales-scroll storyboard-scroll-fade" data-fade={fade} ref={scrollRef}>
        <ChipGroup
          // 侧栏那一处用独立的名字，避免按「语言」查询工具条上的分段时产生歧义
          aria-label={inPanel ? '原文与译文' : '语言'}
          // 槽把选项伸出去的点按热区裁掉，不然外面的滚动区会多出一截能滚的范围、渐隐跟着亮
          className="auto-cols-auto overflow-clip"
          // 原文的语言代码是 null，分段的值用各项不重复的无障碍名称；再点当前语言报的是空值，不切换
          onValueChange={(value) => {
            const next = buttons.find((button) => button.label === value)
            if (next !== undefined) onSwitch(next.code)
          }}
          type="single"
          value={buttons.find((button) => button.code === current)?.label ?? ''}
          variant="segmented"
        >
          {buttons.map((button) => (
            <TooltipRoot key={button.label}>
              <TooltipTrigger asChild>
                <FilterChip aria-label={button.label} value={button.label} variant="segmented">
                  {button.tag}
                </FilterChip>
              </TooltipTrigger>
              <TooltipContent className="wf-tip" side={side}>
                {button.tip}
              </TooltipContent>
            </TooltipRoot>
          ))}
        </ChipGroup>
      </div>
      {addable.length === 0 ? null : <AddLocale addable={addable} onAdd={onAdd} side={side} />}
    </div>
  )
}

/** 当前语言滚进看得见的地方时，两边离滚动区边缘留的空（px），让出渐隐的那一截。 */
const LOCALE_SCROLL_MARGIN = 24

/** 菜单与提示的弹出方向。 */
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
      {/* 菜单展开时抑制 Tooltip，避免遮挡向上弹出的菜单 */}
      <TooltipRoot onOpenChange={setHint} open={hint && !open}>
        <MenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              aria-label="添加语言"
              className="wf-tool wf-locale-add ui-state ui-focus"
              type="button"
            >
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
  /** 选中播放头左侧或右侧的片段（替换当前选区）。 */
  onSelectAround: (side: 'left' | 'right') => void
  /** 在播放头处无法切开选中片段时的禁用原因；可切开时为 `undefined`。 */
  splitBlocked: string | undefined
  /** 在播放头处切开选中片段（等效快捷键 S）。 */
  onSplit: () => void
  /** 是否存在选中片段；无选中时置灰「删除」与「缩放到选中的片段」。 */
  hasSelection: boolean
  /** 删除选中片段（等效快捷键 Delete）。 */
  onRemove: () => void
  /** 分离/合并视频原声按钮配置（等效快捷键 ⇧⌘B）。 */
  sound: { kind: 'detach' | 'merge'; blocked: string | undefined; onClick: () => void }
  onZoomToSelection: () => void
  snap: boolean
  onSnap: () => void
  ripple: boolean
  onRipple: () => void
  zoom: Zoom
  /** 「适应宽度」模式下的每秒像素数，缩放档位与滑杆均以此为基准。 */
  fitPps: number
  onZoom: (zoom: Zoom) => void
  /** 语言切换控件配置，位于右侧工具组首位。 */
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
        <span className="wf-toolbar-cluster">
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
        </span>
        <span className="wf-toolbar-cluster">
          <ToolSwitch onTool={onTool} tool={tool} />
          <EditCommands
            onSelectAround={onSelectAround}
            onSplit={onSplit}
            splitBlocked={splitBlocked}
          />
        </span>
        <span className="wf-toolbar-cluster">
          <Tool
            blocked={sound.blocked}
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
        </span>
        <span className="wf-toolbar-cluster">
          <Tool
            className="is-snap"
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
        </span>
      </div>
      <div className="wf-toolbar-group is-end">
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
