/** 治理者管理标签树：打开时在灵感库里替换卡片列表。顶部一行用下拉切换维度、添加维度、「完成」回到列表；
 * 下面左边是选中维度的名称、「AI 打标」开关与判断说明，右边是它的取值：大类一行，小类缩进排在它下面。
 * 每个操作直接调接口，失败用服务端给的话提示；删除前在那一行原地确认，写出两库各有几条会去掉这个标签。
 * 规则见 contract/conventions.md §15「改树」。 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { LibraryTagUpdateIn } from '@/shared/api/generated/types.gen'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Input, Textarea } from '@/shared/ui/field'
import { useFilterBar } from '@/shared/ui/filter-bar'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import {
  useCreateLibraryTag,
  useDeleteLibraryTag,
  useUpdateLibraryTag,
} from '../library-tag-admin.api'
import { isAiDimension, type LibraryTag, type TagIndex } from '../library-tags'

/** 改树只影响之后的打标；面板里写一次。 */
const RETAG_HINT = '修改仅影响之后的打标，已有的标签不会重打'

const countsOf = (tag: LibraryTag) =>
  `灵感库 ${tag.counts.references} · 爆款 ${tag.counts.hitCases}`

/** 删除前的确认说明，写出两库各有几条会去掉这个标签。 */
const deleteMessageOf = (tag: LibraryTag, dimension: boolean) => {
  const affected = `灵感库 ${tag.counts.references} 条、爆款 ${tag.counts.hitCases} 条`
  if (dimension) return `删除后，${affected}会去掉该维度的全部标签`
  return tag.children.length > 0
    ? `删除后，${affected}会去掉该标签，连同其下级`
    : `删除后，${affected}会去掉该标签`
}

/** 筛选条最右的「管理标签」开关，只给治理者；放在 `FilterBarRoot` 里，点它先收起开着的筛选弹层。 */
export function ManageTagsToggle({
  className,
  open,
  onToggle,
}: {
  /** 照筛选条触发器的外形。 */
  className: string
  open: boolean
  onToggle: () => void
}) {
  const { close } = useFilterBar()
  return (
    <button
      aria-pressed={open}
      className={cn(
        className,
        'inline-flex ui-state cursor-pointer items-center gap-1.5 text-on-surface ui-focus',
        open && 'bg-state-active',
      )}
      onClick={() => {
        close()
        onToggle()
      }}
      type="button"
    >
      <Icon decorative name="settings" size="xs" />
      管理标签
    </button>
  )
}

type LibraryTagAdminProps = {
  index: TagIndex
  /** 回到卡片列表。 */
  onClose: () => void
}

export function LibraryTagAdmin({ index, onClose }: LibraryTagAdminProps) {
  const { dimensions } = index
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addingDimension, setAddingDimension] = useState(false)
  // 同一时刻只开一处：改名、添加小类或删除确认。
  const [editing, setEditing] = useState<Editing>(null)
  const create = useCreateLibraryTag()
  const update = useUpdateLibraryTag()
  const remove = useDeleteLibraryTag()
  const busy = create.isPending || update.isPending || remove.isPending
  const dimension = dimensions.find((one) => one.id === selectedId) ?? dimensions[0]

  /** 交回新标签的 id，没加上是 null，好让输入框决定清不清空。 */
  const add = async (name: string, parentId: string | null): Promise<string | null> => {
    try {
      return (await create.mutateAsync({ name, parentId })).id
    } catch (error) {
      toast.error(errorMessageOf(error, '添加失败'))
      return null
    }
  }
  const change = (id: string, changes: LibraryTagUpdateIn, after?: () => void) =>
    update.mutate(
      { changes, id },
      {
        onError: (error) => toast.error(errorMessageOf(error, '保存失败')),
        onSettled: () => after?.(),
      },
    )
  const destroy = (id: string) =>
    remove.mutate(id, {
      onError: (error) => toast.error(errorMessageOf(error, '删除失败')),
      onSettled: () => setEditing(null),
    })

  const actions: RowActions = {
    busy,
    editing,
    onAddChild: async (parentId, name) => {
      const added = await add(name, parentId)
      if (added !== null) setEditing(null)
      return added !== null
    },
    onDelete: destroy,
    onEdit: setEditing,
    onMove: (id, position) => change(id, { position }),
    onRename: (id, name) => change(id, { name }, () => setEditing(null)),
  }

  return (
    <section aria-label="管理标签" className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {dimension === undefined ? null : (
          <DimensionSwitcher
            current={dimension}
            dimensions={dimensions}
            onSelect={(id) => {
              setEditing(null)
              setSelectedId(id)
            }}
          />
        )}
        {addingDimension ? (
          <NameForm
            busy={busy}
            className="w-full sm:w-auto"
            focusOnMount
            label="维度名称"
            onCancel={() => setAddingDimension(false)}
            onSubmit={async (name) => {
              const added = await add(name, null)
              if (added === null) return false
              setAddingDimension(false)
              setSelectedId(added)
              return true
            }}
            placeholder="输入维度名称"
            submitLabel="添加"
          />
        ) : (
          <Button
            leadingIcon="add"
            onClick={() => setAddingDimension(true)}
            size="md"
            variant="outlined"
          >
            添加维度
          </Button>
        )}
        <Button className="ml-auto" onClick={onClose} size="md" variant="inverted">
          完成
        </Button>
      </div>

      {dimension === undefined ? (
        <p className="py-10 text-center text-body text-on-surface-variant">
          暂无维度，请点击「添加维度」
        </p>
      ) : (
        <DimensionEditor
          actions={actions}
          dimension={dimension}
          key={dimension.id}
          onAddValue={async (name) => (await add(name, dimension.id)) !== null}
          onChange={(changes, after) => change(dimension.id, changes, after)}
        />
      )}
    </section>
  )
}

function DimensionSwitcher({
  dimensions,
  current,
  onSelect,
}: {
  dimensions: readonly LibraryTag[]
  current: LibraryTag
  onSelect: (id: string) => void
}) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label={`切换维度，当前为${current.name}`}
          className="inline-flex h-(--control-height-md) max-w-full ui-state cursor-pointer items-center gap-1.5 rounded-sm border border-outline-variant px-3 text-body-sm text-on-surface ui-focus data-[state=open]:bg-state-active"
          type="button"
        >
          <span className="text-on-surface-faint">维度</span>
          <span className="min-w-0 truncate font-medium">{current.name}</span>
          <Icon decorative name="expand" size="xs" />
        </button>
      </MenuTrigger>
      <MenuSurface align="start" className="max-h-80 overflow-y-auto">
        <MenuRadioGroup onValueChange={onSelect} value={current.id}>
          {dimensions.map((one) => (
            <MenuRadioItem key={one.id} value={one.id}>
              <span className="min-w-0 flex-1 truncate">{one.name}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}

type Editing = { kind: 'rename' | 'add' | 'delete'; id: string } | null

type RowActions = {
  busy: boolean
  editing: Editing
  onEdit: (next: Editing) => void
  onRename: (id: string, name: string) => void
  onMove: (id: string, position: number) => void
  onDelete: (id: string) => void
  /** 交回是否加上了。 */
  onAddChild: (parentId: string, name: string) => Promise<boolean>
}

function DimensionEditor({
  dimension,
  actions,
  onChange,
  onAddValue,
}: {
  dimension: LibraryTag
  actions: RowActions
  onChange: (changes: LibraryTagUpdateIn, after?: () => void) => void
  onAddValue: (name: string) => Promise<boolean>
}) {
  const { busy, editing, onEdit } = actions
  const renaming = editing?.kind === 'rename' && editing.id === dimension.id
  const confirming = editing?.kind === 'delete' && editing.id === dimension.id
  const ai = isAiDimension(dimension)

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="grid gap-4 lg:sticky lg:top-16">
        <div className="grid gap-1.5">
          <div className="flex min-h-(--control-height-md) items-center gap-2">
            {renaming ? (
              <RenameInput
                label="维度名称"
                name={dimension.name}
                onCancel={() => onEdit(null)}
                onCommit={(name) => onChange({ name }, () => onEdit(null))}
              />
            ) : (
              <>
                <h2 className="min-w-0 truncate text-title font-medium text-on-surface">
                  {dimension.name}
                </h2>
                <IconButton
                  disabled={busy}
                  label={`重命名${dimension.name}`}
                  name="edit"
                  onClick={() => onEdit({ id: dimension.id, kind: 'rename' })}
                  size="xs"
                />
                <IconButton
                  className="ml-auto"
                  disabled={busy}
                  label={`删除${dimension.name}`}
                  name="delete"
                  onClick={() => onEdit({ id: dimension.id, kind: 'delete' })}
                  size="xs"
                />
              </>
            )}
          </div>
          <p className="text-body-sm text-on-surface-faint">{countsOf(dimension)}</p>
        </div>
        {confirming ? (
          <DeleteConfirm
            busy={busy}
            message={deleteMessageOf(dimension, true)}
            onCancel={() => onEdit(null)}
            onConfirm={() => actions.onDelete(dimension.id)}
          />
        ) : null}

        <Switch
          checked={ai}
          disabled={busy}
          label="AI 打标"
          onChange={(next) => onChange({ autoFill: next ? 'ai' : null })}
        />

        <GuideField guide={dimension.guide} onSave={(guide) => onChange({ guide })} />
        <p className="text-body-sm text-on-surface-faint">{RETAG_HINT}</p>
      </div>

      <div className="grid gap-3">
        {dimension.children.length === 0 ? (
          <p className="py-4 text-body-sm text-on-surface-variant">暂无取值，请在下方添加</p>
        ) : (
          <ul aria-label={`${dimension.name}的取值`} className="grid gap-0.5">
            {dimension.children.map((value, position) => (
              <ValueRow
                actions={actions}
                depth={0}
                key={value.id}
                position={position}
                siblings={dimension.children.length}
                tag={value}
              />
            ))}
          </ul>
        )}
        <NameForm
          busy={busy}
          label="取值名称"
          onSubmit={onAddValue}
          placeholder="输入取值名称"
          submitLabel="添加取值"
        />
      </div>
    </div>
  )
}

function ValueRow({
  tag,
  depth,
  position,
  siblings,
  actions,
}: {
  tag: LibraryTag
  depth: 0 | 1
  position: number
  siblings: number
  actions: RowActions
}) {
  const { busy, editing, onEdit } = actions
  const mine = editing !== null && editing.id === tag.id
  const renaming = mine && editing.kind === 'rename'
  const adding = mine && editing.kind === 'add'
  const confirming = mine && editing.kind === 'delete'

  return (
    <li className="grid gap-0.5">
      <div
        className={cn(
          'flex min-h-(--control-height-md) flex-wrap items-center gap-x-2 rounded-sm px-2 hover:bg-state-hover',
          depth === 1 && 'ml-6',
        )}
      >
        {renaming ? (
          <RenameInput
            label={`${tag.name}的新名称`}
            name={tag.name}
            onCancel={() => onEdit(null)}
            onCommit={(name) => actions.onRename(tag.id, name)}
          />
        ) : (
          <>
            <span
              className={cn(
                'min-w-0 flex-1 text-body-sm break-all text-on-surface',
                depth === 0 && tag.children.length > 0 && 'font-medium',
              )}
            >
              {tag.name}
            </span>
            <span className="shrink-0 text-label text-on-surface-faint tabular-nums">
              {countsOf(tag)}
            </span>
            <span className="flex shrink-0 items-center">
              <IconButton
                disabled={busy}
                label={`重命名${tag.name}`}
                name="edit"
                onClick={() => onEdit({ id: tag.id, kind: 'rename' })}
                size="xs"
              />
              <IconButton
                disabled={busy || position === 0}
                label={`上移${tag.name}`}
                name="move-up"
                onClick={() => actions.onMove(tag.id, position - 1)}
                size="xs"
              />
              <IconButton
                disabled={busy || position === siblings - 1}
                label={`下移${tag.name}`}
                name="move-down"
                onClick={() => actions.onMove(tag.id, position + 1)}
                size="xs"
              />
              {depth === 0 ? (
                <IconButton
                  disabled={busy}
                  label={`给${tag.name}添加小类`}
                  name="add"
                  onClick={() => onEdit({ id: tag.id, kind: 'add' })}
                  size="xs"
                />
              ) : (
                // 小类没有「添加小类」，留出同样的宽，条数与大类对齐。
                <span aria-hidden className="size-(--control-height-xs)" />
              )}
              <IconButton
                disabled={busy}
                label={`删除${tag.name}`}
                name="delete"
                onClick={() => onEdit({ id: tag.id, kind: 'delete' })}
                size="xs"
              />
            </span>
          </>
        )}
      </div>
      {confirming ? (
        <div className={cn('px-2', depth === 1 && 'ml-6')}>
          <DeleteConfirm
            busy={busy}
            message={deleteMessageOf(tag, false)}
            onCancel={() => onEdit(null)}
            onConfirm={() => actions.onDelete(tag.id)}
          />
        </div>
      ) : null}
      {tag.children.length > 0 ? (
        <ul aria-label={`${tag.name}的小类`} className="grid gap-0.5">
          {tag.children.map((child, childPosition) => (
            <ValueRow
              actions={actions}
              depth={1}
              key={child.id}
              position={childPosition}
              siblings={tag.children.length}
              tag={child}
            />
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className="ml-6 px-2 py-1">
          <NameForm
            busy={busy}
            focusOnMount
            label={`${tag.name}的小类名称`}
            onCancel={() => onEdit(null)}
            onSubmit={(name) => actions.onAddChild(tag.id, name)}
            placeholder="输入小类名称"
            submitLabel="添加"
          />
        </div>
      ) : null}
    </li>
  )
}

/** 原地确认：说明影响面，取消或删除。 */
function DeleteConfirm({
  message,
  busy,
  onCancel,
  onConfirm,
}: {
  message: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-sm border border-outline-variant px-3 py-2">
      <span className="min-w-0 flex-1 text-body-sm text-balance text-on-surface" role="status">
        {message}
      </span>
      <Button className="shrink-0" onClick={onCancel} size="md" variant="outlined">
        取消
      </Button>
      <Button className="shrink-0" loading={busy} onClick={onConfirm} size="md" variant="inverted">
        删除
      </Button>
    </div>
  )
}

/** 一行名称输入加提交按钮；回车提交，Esc 取消。提交成功才清空。 */
function NameForm({
  label,
  placeholder,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  focusOnMount = false,
  className,
}: {
  label: string
  placeholder: string
  submitLabel: string
  busy: boolean
  /** 交回是否成功。 */
  onSubmit: (name: string) => Promise<boolean>
  onCancel?: () => void
  /** 点了「添加」才出现的输入框，出现就是为了输入，直接落焦点。 */
  focusOnMount?: boolean
  className?: string
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus()
  }, [focusOnMount])
  const submit = async () => {
    if (value.trim() === '' || busy) return
    if (await onSubmit(value)) setValue('')
  }
  return (
    <form
      className={cn('flex min-w-0 items-center gap-2', className)}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Input
        aria-label={label}
        className="h-(--control-height-md) min-w-0 flex-1 text-body-sm sm:w-56 sm:flex-none"
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && onCancel !== undefined) {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder={placeholder}
        ref={inputRef}
        value={value}
      />
      <Button
        className="shrink-0"
        disabled={value.trim() === ''}
        loading={busy}
        size="md"
        type="submit"
        variant="outlined"
      >
        {submitLabel}
      </Button>
      {onCancel === undefined ? null : (
        <Button className="shrink-0" onClick={onCancel} size="md" variant="ghost">
          取消
        </Button>
      )}
    </form>
  )
}

/** 就地改名：回车或移开焦点保存，Esc 取消；没改就当取消。 */
function RenameInput({
  name,
  label,
  onCommit,
  onCancel,
}: {
  name: string
  label: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  // 回车保存后输入框卸载还会再失焦一次，只认第一次。
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 点了「重命名」就是要改，直接落焦点并选中原名。
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const finish = (value: string | null) => {
    if (doneRef.current) return
    doneRef.current = true
    if (value === null || value.trim() === name) onCancel()
    else onCommit(value)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(event.currentTarget.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(null)
    }
  }
  return (
    <Input
      aria-label={label}
      className="h-(--control-height-sm) min-w-0 flex-1 px-2 text-body-sm"
      defaultValue={name}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      ref={inputRef}
    />
  )
}

/** 判断说明：多行输入，移开焦点或回车保存（Shift+回车换行），没改不发。 */
function GuideField({ guide, onSave }: { guide: string | null; onSave: (guide: string) => void }) {
  const [draft, setDraft] = useState(guide ?? '')
  const id = useId()
  const save = () => {
    if (draft.trim() !== (guide ?? '')) onSave(draft)
  }
  return (
    <div className="grid gap-1.5">
      <label className="text-body-sm text-on-surface-variant" htmlFor={id}>
        判断说明
      </label>
      <Textarea
        className="min-h-24 resize-y text-body-sm"
        id={id}
        onBlur={save}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        placeholder="说明如何判断该维度，打标时一并提供给 AI"
        rows={3}
        value={draft}
      />
    </div>
  )
}

/** 开关：浅色轨道，开时墨色；整行文字也能点。 */
function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  label: ReactNode
  onChange: (next: boolean) => void
}) {
  return (
    <button
      aria-checked={checked}
      className="inline-flex w-fit ui-state cursor-pointer items-center gap-2.5 rounded-sm text-body-sm text-on-surface ui-focus disabled:cursor-not-allowed"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        aria-hidden
        className={cn(
          'relative h-4.5 w-8 shrink-0 rounded-full border transition-colors ui-motion-s',
          checked ? 'border-inverse-surface bg-inverse-surface' : 'border-outline bg-transparent',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-3 rounded-full transition-transform ui-motion-s',
            checked ? 'translate-x-3.5 bg-inverse-on-surface' : 'bg-on-surface-variant',
          )}
        />
      </span>
      {label}
    </button>
  )
}
