import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { fileKindOf } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { fileLabel, SKILL_MD } from '../skill-files'

/** 页签行此刻在做的事：添加参考文件、给一个改名、确认删除一个；null 是平常的页签。 */
export type FileTabsMode =
  { type: 'add' } | { type: 'rename'; path: string } | { type: 'delete'; path: string } | null

/** 需要聚焦的元素：页签用文件路径，另有「添加参考文件」按钮、文件名输入框与删除确认里的「取消」。 */
export type FileTabsFocusKey = string

export const ADD_KEY = '+add'
export const NAME_KEY = '+name'
export const KEEP_KEY = '+keep'

type SkillFileTabsProps = {
  paths: readonly string[]
  active: string
  mode: FileTabsMode
  name: string
  nameError: string | null
  /** 改名或删除正在提交。 */
  pending: boolean
  /** 保存或发布中：不能增删改文件。 */
  disabled: boolean
  /** 改名、新建与删除确认会换掉页签里的元素，焦点由编辑器按这些元素去放。 */
  registerElement: (key: FileTabsFocusKey, element: HTMLElement | null) => void
  onSelect: (path: string, focus: boolean) => void
  onStartAdd: () => void
  onStartRename: (path: string) => void
  onStartDelete: (path: string) => void
  onNameChange: (name: string) => void
  onApply: () => void
  onCancel: () => void
  onConfirmDelete: () => void
}

const TAB_CLASS =
  'flex h-7.5 shrink-0 items-center rounded-sm text-body-sm text-on-surface-variant ui-state'

type Overflow = 'none' | 'start' | 'end' | 'both'

// 放不下时，哪一侧还有页签就在哪一侧淡出 40px。
const FADE: Record<Overflow, string | undefined> = {
  both: 'linear-gradient(to right, transparent, black 40px, black calc(100% - 40px), transparent)',
  end: 'linear-gradient(to right, black calc(100% - 40px), transparent)',
  none: undefined,
  start: 'linear-gradient(to right, transparent, black 40px)',
}

const overflowOf = (scroller: HTMLElement): Overflow => {
  const start = scroller.scrollLeft > 1
  const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
}

/**
 * 技能文件的页签栏，编辑器上方单独一行，底边一条细线贯穿面板：`SKILL.md`、一道竖线、参考文件（全名、不折行），
 * 放不下时横向滚动、两侧淡出；「+」固定在最右。选中的参考文件带「⋯」（重命名 / 删除），双击也是重命名；
 * 改名与删除确认就地替换这一格，新建的文件名输入框替换「+」。
 */
export function SkillFileTabs({
  active,
  disabled,
  mode,
  name,
  nameError,
  onApply,
  onCancel,
  onConfirmDelete,
  onNameChange,
  onSelect,
  onStartAdd,
  onStartDelete,
  onStartRename,
  paths,
  pending,
  registerElement,
}: SkillFileTabsProps) {
  // 选了菜单里的动作时，焦点交给输入框或确认按钮，不还给「⋯」。
  const choseRef = useRef(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [overflow, setOverflow] = useState<Overflow>('none')

  // 页签增删改名会改变内容宽度，面板拉宽拉窄会改变可见宽度，两者都要重新判断两侧有没有藏着的页签。
  useEffect(() => {
    const scroller = scrollerRef.current
    const list = listRef.current
    if (scroller === null || list === null) return
    const observer = new ResizeObserver(() => setOverflow(overflowOf(scroller)))
    observer.observe(scroller)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const navigate = (event: KeyboardEvent, index: number) => {
    const last = paths.length - 1
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    const path = paths[next]
    if (path !== undefined) onSelect(path, true)
  }

  // Esc 只收起输入框或删除确认，不连带关掉面板。面板的 Esc 是挂在面板 DOM 上的原生监听，
  // 比 React 冒泡阶段的处理先到，所以在捕获阶段拦下（标成已处理，面板就不理它）。
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    onCancel()
  }

  const nameInput = (
    <span className="flex w-50 shrink-0 flex-col gap-1 py-0.5">
      <Input
        aria-describedby={nameError === null ? undefined : `${NAME_KEY}-error`}
        aria-invalid={nameError !== null}
        aria-label={mode?.type === 'rename' ? '新文件名' : '参考文件名'}
        autoComplete="off"
        className="h-7.5 rounded-sm px-2 text-label"
        disabled={pending}
        onBlur={(event) => {
          if (event.currentTarget.value.trim() === '' && !pending) onCancel()
        }}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onApply()
          }
        }}
        onKeyDownCapture={cancelOnEscape}
        placeholder="文件名.md"
        ref={(element) => registerElement(NAME_KEY, element)}
        spellCheck={false}
        value={name}
      />
      {nameError === null ? null : (
        <span className="text-label text-error" id={`${NAME_KEY}-error`} role="alert">
          {nameError}
        </span>
      )}
    </span>
  )

  const tab = (path: string, index: number) => {
    const label = fileLabel(path)
    const selected = path === active
    const reference = path !== SKILL_MD
    // 页签外面的 li 只管排版，读屏只看到 tablist 里的 tab。
    if (mode?.type === 'rename' && mode.path === path)
      return (
        <li key={path} role="presentation">
          {nameInput}
        </li>
      )
    if (mode?.type === 'delete' && mode.path === path)
      return (
        <li
          className={cn(TAB_CLASS, 'gap-1.5 bg-state-active pr-1 pl-3 text-on-surface')}
          key={path}
          role="presentation"
          onKeyDownCapture={cancelOnEscape}
        >
          <span className="whitespace-nowrap">删除 {label}？</span>
          <button
            className="h-6 ui-state cursor-pointer rounded-sm px-2 font-medium text-error ui-focus"
            disabled={pending}
            onClick={onConfirmDelete}
            type="button"
          >
            删除
          </button>
          <button
            className="h-6 ui-state cursor-pointer rounded-sm px-2 ui-focus"
            disabled={pending}
            onClick={onCancel}
            ref={(element) => registerElement(KEEP_KEY, element)}
            type="button"
          >
            取消
          </button>
        </li>
      )
    return (
      <li
        className={cn(TAB_CLASS, selected && 'bg-state-active font-medium text-on-surface')}
        key={path}
        role="presentation"
      >
        <button
          aria-selected={selected}
          className={cn(
            'inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-sm pr-2.5 pl-2 whitespace-nowrap ui-focus',
            selected && reference && 'pr-0.5',
          )}
          onClick={() => onSelect(path, false)}
          onDoubleClick={() => {
            if (reference && !disabled) onStartRename(path)
          }}
          onKeyDown={(event) => navigate(event, index)}
          ref={(element) => registerElement(path, element)}
          role="tab"
          tabIndex={selected ? 0 : -1}
          type="button"
        >
          <Icon
            className={selected ? 'text-on-surface-variant' : 'text-on-surface-faint'}
            decorative
            name={fileKindOf(path) === 'json' ? 'file-json' : 'file'}
            size="sm"
          />
          {label}
        </button>
        {selected && reference ? (
          <MenuRoot>
            <MenuTrigger asChild disabled={disabled}>
              <IconButton
                className="mr-1"
                label={`${label} 的操作`}
                name="more"
                size="xs"
                tooltip="重命名或删除"
              />
            </MenuTrigger>
            <MenuSurface
              align="start"
              onCloseAutoFocus={(event) => {
                if (!choseRef.current) return
                choseRef.current = false
                event.preventDefault()
              }}
            >
              <MenuItem
                icon="edit"
                onSelect={() => {
                  choseRef.current = true
                  onStartRename(path)
                }}
              >
                重命名
              </MenuItem>
              <MenuItem
                destructive
                icon="delete"
                onSelect={() => {
                  choseRef.current = true
                  onStartDelete(path)
                }}
              >
                删除
              </MenuItem>
            </MenuSurface>
          </MenuRoot>
        ) : null}
      </li>
    )
  }

  const references = paths.filter((path) => path !== SKILL_MD)
  return (
    <div className="-mx-6 flex shrink-0 items-center gap-1 border-b border-hairline pr-4 pb-2 pl-5">
      <div
        className="hide-scrollbar min-w-0 flex-1 overflow-x-auto"
        onScroll={(event) => setOverflow(overflowOf(event.currentTarget))}
        ref={scrollerRef}
        style={{ maskImage: FADE[overflow] }}
      >
        <ul
          aria-label="技能文件"
          className="flex w-max items-center gap-0.5"
          ref={listRef}
          role="tablist"
        >
          {tab(SKILL_MD, 0)}
          {references.length === 0 ? null : (
            <li aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-hairline" role="presentation" />
          )}
          {references.map((path, index) => tab(path, index + 1))}
        </ul>
      </div>
      {mode?.type === 'add' ? (
        nameInput
      ) : (
        <IconButton
          disabled={disabled}
          label="添加参考文件"
          name="add"
          onClick={onStartAdd}
          ref={(element) => registerElement(ADD_KEY, element)}
          size="xs"
        />
      )}
    </div>
  )
}
