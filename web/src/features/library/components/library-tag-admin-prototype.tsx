/** 方案二的标签管理交互原型；由 mock 专用入口挂载，复用现有标签合同与写入流程。 */
import { useEffect, useId, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { LibraryTagUpdateIn } from '@/shared/api/generated/types.gen'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { Input, Textarea } from '@/shared/ui/field'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import {
  useCreateLibraryTag,
  useDeleteLibraryTag,
  useUpdateLibraryTag,
} from '../library-tag-admin.api'
import { isAiDimension, type LibraryTag, type TagIndex } from '../library-tags'
import './library-tag-admin-prototype.css'

type Editing = { kind: 'add' | 'rename'; id: string; focus: boolean } | null
type DialogState = { kind: 'rules' | 'delete'; tag: LibraryTag; dimension: boolean } | null
type Column = 'left' | 'middle' | 'right'

const COLUMNS: readonly Column[] = ['left', 'middle', 'right']
const RETAG_HINT = '修改仅影响之后的打标，已有标签不会重打。'

const initialColumn = (name: string): Column => {
  if (name === '内容结构') return 'right'
  if (name === '品类' || name === '场景') return 'middle'
  return 'left'
}

const matchesSearch = (tag: LibraryTag, query: string): boolean =>
  tag.name.toLocaleLowerCase().includes(query) ||
  tag.children.some((child) => matchesSearch(child, query))

type Actions = {
  busy: boolean
  editing: Editing
  edit: (next: Editing) => void
  openDialog: (next: DialogState) => void
  add: (name: string, parentId: string | null) => Promise<boolean>
  change: (tag: LibraryTag, changes: LibraryTagUpdateIn) => Promise<boolean>
}

export function LibraryTagAdminPrototype({
  index,
  onClose,
}: {
  index: TagIndex
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Editing>(() => {
    const brand = index.dimensions.find((dimension) => dimension.name === '品牌')
    return brand === undefined ? null : { focus: false, id: brand.id, kind: 'add' }
  })
  const [dialog, setDialog] = useState<DialogState>(null)
  const [creatingDimension, setCreatingDimension] = useState(false)
  const addDimensionRef = useRef<HTMLButtonElement>(null)
  const closeCreate = () => {
    setCreatingDimension(false)
    addDimensionRef.current?.focus()
  }
  // 原型的初始版式按维度名称确定；后续改名保持位置，新维度排在左列首位。
  const [columnById] = useState(
    () =>
      new Map(index.dimensions.map((dimension) => [dimension.id, initialColumn(dimension.name)])),
  )
  const [initiallyExpanded] = useState(
    () =>
      new Set(
        index.dimensions
          .find((dimension) => dimension.name === '内容结构')
          ?.children.slice(0, 2)
          .map((tag) => tag.id),
      ),
  )
  const create = useCreateLibraryTag()
  const update = useUpdateLibraryTag()
  const remove = useDeleteLibraryTag()
  const busy = create.isPending || update.isPending || remove.isPending
  const query = search.trim().toLocaleLowerCase()
  const visibleDimensions = index.dimensions.filter((tag) => matchesSearch(tag, query))

  const actions: Actions = {
    add: async (name, parentId) => {
      try {
        await create.mutateAsync({ name, parentId, ...(parentId === null ? { position: 0 } : {}) })
        setEditing(null)
        setSearch('')
        return true
      } catch (error) {
        toast.error(errorMessageOf(error, '添加失败，请重试'))
        return false
      }
    },
    busy,
    change: async (tag, changes) => {
      try {
        await update.mutateAsync({ changes, id: tag.id })
        setEditing(null)
        return true
      } catch (error) {
        toast.error(errorMessageOf(error, '保存失败，请重试'))
        return false
      }
    },
    edit: setEditing,
    editing,
    openDialog: setDialog,
  }

  return (
    <section aria-label="管理标签" className="tag-admin-prototype">
      <div className="tag-admin-prototype__toolbar">
        <h2>管理标签</h2>
        <Input
          aria-label="搜索标签名称"
          className="text-body"
          leadingIcon="search"
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="搜索标签名称"
          trailingAction={
            search ? (
              <IconButton label="清除搜索" name="close" onClick={() => setSearch('')} size="xs" />
            ) : undefined
          }
          value={search}
          wrapperClassName="tag-admin-prototype__search"
        />
        <Button
          aria-expanded={creatingDimension}
          disabled={busy}
          leadingIcon="add"
          onClick={() => {
            setSearch('')
            setEditing(null)
            setCreatingDimension(true)
          }}
          ref={addDimensionRef}
          size="md"
          variant="outlined"
        >
          添加维度
        </Button>
        <span className="tag-admin-prototype__legend">使用量：灵感库 / 爆款素材库</span>
        <Button
          className="tag-admin-prototype__done"
          onClick={onClose}
          size="md"
          variant="inverted"
        >
          完成
        </Button>
      </div>
      <p className="tag-admin-prototype__hint">{RETAG_HINT}</p>

      {visibleDimensions.length > 0 || creatingDimension ? (
        <div className="tag-admin-prototype__grid">
          {COLUMNS.map((column) => {
            const siblings = index.dimensions.filter(
              (tag) => (columnById.get(tag.id) ?? 'left') === column,
            )
            return (
              <div className="tag-admin-prototype__column" key={column}>
                {column === 'left' && creatingDimension ? (
                  <section aria-label="新维度" className="tag-admin-prototype__card">
                    <div className="tag-admin-prototype__card-heading">
                      <h3>新维度</h3>
                    </div>
                    <CreateDimensionForm
                      busy={busy}
                      onCancel={closeCreate}
                      onSubmit={async (name) => {
                        if (await actions.add(name, null)) {
                          closeCreate()
                          return true
                        }
                        return false
                      }}
                    />
                  </section>
                ) : null}
                {visibleDimensions
                  .filter((tag) => (columnById.get(tag.id) ?? 'left') === column)
                  .map((dimension) => (
                    <DimensionCard
                      actions={actions}
                      dimension={dimension}
                      initiallyExpanded={initiallyExpanded}
                      key={dimension.id}
                      query={query}
                      siblings={siblings}
                    />
                  ))}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="tag-admin-prototype__empty" role="status">
          <Icon decorative name={query ? 'search' : 'tag'} size="lg" />
          <p>{query ? `未找到「${search.trim()}」相关的标签` : '暂无维度，请点击「添加维度」'}</p>
          {query ? (
            <Button onClick={() => setSearch('')} size="md" variant="ghost">
              清除搜索
            </Button>
          ) : null}
        </div>
      )}

      <DialogRoot onOpenChange={(open) => !open && setDialog(null)} open={dialog !== null}>
        {dialog === null ? null : (
          <DialogSurface aria-describedby={undefined} returnFocus>
            {dialog.kind === 'rules' ? (
              <RulesEditor
                busy={busy}
                dimension={dialog.dimension}
                key={dialog.tag.id}
                onCancel={() => setDialog(null)}
                onSave={async (changes) => {
                  if (await actions.change(dialog.tag, changes)) setDialog(null)
                }}
                tag={dialog.tag}
              />
            ) : (
              <>
                <DialogHeader closeLabel="关闭删除确认" title={`删除「${dialog.tag.name}」`} />
                <DialogBody>
                  <p className="text-body leading-relaxed text-on-surface-variant">
                    删除后，灵感库 {dialog.tag.counts.references} 条、爆款素材库{' '}
                    {dialog.tag.counts.hitCases} 条中的
                    {dialog.dimension
                      ? '该维度及全部下级标签'
                      : dialog.tag.children.length > 0
                        ? '该标签及全部小类'
                        : '该标签'}
                    将一并移除。此操作无法撤销。
                  </p>
                  <div className="tag-admin-prototype__dialog-actions">
                    <Button
                      disabled={busy}
                      onClick={() => setDialog(null)}
                      size="md"
                      variant="ghost"
                    >
                      取消
                    </Button>
                    <Button
                      loading={busy}
                      onClick={() => {
                        remove.mutate(dialog.tag.id, {
                          onError: (error) =>
                            toast.error(errorMessageOf(error, '删除失败，请重试')),
                          onSuccess: () => {
                            setDialog(null)
                            setEditing(null)
                          },
                        })
                      }}
                      size="md"
                      variant="danger"
                    >
                      删除
                    </Button>
                  </div>
                </DialogBody>
              </>
            )}
          </DialogSurface>
        )}
      </DialogRoot>
    </section>
  )
}

function DimensionCard({
  dimension,
  siblings,
  query,
  initiallyExpanded,
  actions,
}: {
  dimension: LibraryTag
  siblings: readonly LibraryTag[]
  query: string
  initiallyExpanded: ReadonlySet<string>
  actions: Actions
}) {
  const [showAll, setShowAll] = useState(false)
  const headingId = useId()
  const childQuery = dimension.name.toLocaleLowerCase().includes(query) ? '' : query
  const matching = dimension.children.filter((tag) => matchesSearch(tag, childQuery))
  const children = showAll || query ? matching : matching.slice(0, 10)
  const adding = actions.editing?.id === dimension.id && actions.editing.kind === 'add'
  const renaming = actions.editing?.id === dimension.id && actions.editing.kind === 'rename'

  return (
    <section aria-labelledby={headingId} className="tag-admin-prototype__card">
      <div className="tag-admin-prototype__card-heading">
        <h3 id={headingId}>{dimension.name}</h3>
        <span className="tag-admin-prototype__mode">
          {isAiDimension(dimension) ? '自动' : '人工'}
        </span>
        <div className="tag-admin-prototype__card-tools">
          <IconButton
            disabled={actions.busy}
            label={`给${dimension.name}添加标签`}
            name="add"
            onClick={() => actions.edit({ focus: true, id: dimension.id, kind: 'add' })}
            size="xs"
          />
          <TagMenu actions={actions} dimension siblings={siblings} tag={dimension} />
        </div>
      </div>

      {renaming ? (
        <NameForm
          busy={actions.busy}
          focus
          initialValue={dimension.name}
          label={`${dimension.name}的新名称`}
          onCancel={() => actions.edit(null)}
          onSubmit={(name) => actions.change(dimension, { name })}
          placeholder="输入维度名称"
          rename
        />
      ) : null}
      {adding ? (
        <NameForm
          busy={actions.busy}
          focus={actions.editing?.focus ?? false}
          label={`${dimension.name}的标签名称`}
          onCancel={() => actions.edit(null)}
          onSubmit={async (name) => {
            const added = await actions.add(name, dimension.id)
            if (added) setShowAll(true)
            return added
          }}
          placeholder={dimension.name === '品牌' ? '输入品牌名称' : '输入标签名称'}
        />
      ) : null}

      {dimension.children.length > 0 ? (
        <>
          <div aria-hidden className="tag-admin-prototype__count-head">
            <span />
            <span>灵感库</span>
            <span>爆款</span>
            <span />
          </div>
          <ul aria-label={`${dimension.name}的标签`} className="tag-admin-prototype__list">
            {children.map((tag) => (
              <TagRow
                actions={actions}
                depth={0}
                initiallyExpanded={initiallyExpanded}
                key={tag.id}
                query={childQuery}
                siblings={dimension.children}
                tag={tag}
              />
            ))}
          </ul>
          {!query && matching.length > 10 ? (
            <button
              aria-expanded={showAll}
              className="tag-admin-prototype__show-all ui-focus"
              onClick={() => setShowAll(!showAll)}
              type="button"
            >
              {showAll ? '收起' : `查看全部 ${matching.length} 个`}
              <Icon decorative name={showAll ? 'collapse' : 'expand'} size="xs" />
            </button>
          ) : null}
        </>
      ) : (
        <p className="tag-admin-prototype__card-empty">
          {dimension.name === '品牌' ? '尚未添加品牌' : '暂无标签，请点击右上角添加'}
        </p>
      )}
    </section>
  )
}

function TagRow({
  tag,
  siblings,
  depth,
  query,
  initiallyExpanded,
  actions,
}: {
  tag: LibraryTag
  siblings: readonly LibraryTag[]
  depth: 0 | 1
  query: string
  initiallyExpanded: ReadonlySet<string>
  actions: Actions
}) {
  const [open, setOpen] = useState(() => initiallyExpanded.has(tag.id))
  const adding = actions.editing?.id === tag.id && actions.editing.kind === 'add'
  const renaming = actions.editing?.id === tag.id && actions.editing.kind === 'rename'
  const hasChildren = tag.children.length > 0
  const expanded = open || Boolean(query) || adding
  const children = tag.name.toLocaleLowerCase().includes(query)
    ? tag.children
    : tag.children.filter((child) => matchesSearch(child, query))

  return (
    <li className={cn('tag-admin-prototype__item', hasChildren && 'tag-admin-prototype__branch')}>
      {renaming ? (
        <NameForm
          busy={actions.busy}
          focus
          initialValue={tag.name}
          label={`${tag.name}的新名称`}
          onCancel={() => actions.edit(null)}
          onSubmit={(name) => actions.change(tag, { name })}
          placeholder="输入标签名称"
          rename
        />
      ) : (
        <div
          className={cn('tag-admin-prototype__row', depth === 1 && 'tag-admin-prototype__child')}
        >
          {hasChildren ? (
            <button
              aria-expanded={expanded}
              className="tag-admin-prototype__branch-label ui-focus"
              onClick={() => setOpen(!open)}
              type="button"
            >
              <Icon decorative name={expanded ? 'expand' : 'disclosure'} size="xs" />
              <span>{tag.name}</span>
            </button>
          ) : (
            <span className="tag-admin-prototype__name">{tag.name}</span>
          )}
          <span
            aria-label={`灵感库 ${tag.counts.references} 条`}
            className={cn('tag-admin-prototype__count', tag.counts.references === 0 && 'is-zero')}
          >
            {tag.counts.references}
          </span>
          <span
            aria-label={`爆款素材库 ${tag.counts.hitCases} 条`}
            className={cn('tag-admin-prototype__count', tag.counts.hitCases === 0 && 'is-zero')}
          >
            {tag.counts.hitCases}
          </span>
          <TagMenu actions={actions} depth={depth} siblings={siblings} tag={tag} />
        </div>
      )}
      {expanded && hasChildren ? (
        <ul aria-label={`${tag.name}的小类`} className="tag-admin-prototype__children">
          {children.map((child) => (
            <TagRow
              actions={actions}
              depth={1}
              initiallyExpanded={initiallyExpanded}
              key={child.id}
              query={query}
              siblings={tag.children}
              tag={child}
            />
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className="tag-admin-prototype__child-form">
          <NameForm
            busy={actions.busy}
            focus
            label={`${tag.name}的小类名称`}
            onCancel={() => actions.edit(null)}
            onSubmit={async (name) => {
              const added = await actions.add(name, tag.id)
              if (added) setOpen(true)
              return added
            }}
            placeholder="输入小类名称"
          />
        </div>
      ) : null}
    </li>
  )
}

function TagMenu({
  tag,
  siblings,
  actions,
  dimension = false,
  depth = 0,
}: {
  tag: LibraryTag
  siblings: readonly LibraryTag[]
  actions: Actions
  dimension?: boolean
  depth?: 0 | 1
}) {
  const redirectFocusRef = useRef(false)
  const position = siblings.findIndex((sibling) => sibling.id === tag.id)
  const previous = siblings[position - 1]
  const next = siblings[position + 1]
  const edit = (kind: 'add' | 'rename') => {
    redirectFocusRef.current = true
    actions.edit({ focus: true, id: tag.id, kind })
  }
  const openDialog = (kind: 'rules' | 'delete') => {
    redirectFocusRef.current = true
    actions.openDialog({ dimension, kind, tag })
  }

  return (
    <MenuRoot>
      <MenuTrigger asChild disabled={actions.busy}>
        <IconButton
          className={cn('tag-admin-prototype__more', dimension && 'is-dimension')}
          label={`管理${tag.name}`}
          name="more"
          size="xs"
        />
      </MenuTrigger>
      <MenuSurface
        align="end"
        onCloseAutoFocus={(event) => {
          if (redirectFocusRef.current) event.preventDefault()
          redirectFocusRef.current = false
        }}
      >
        <MenuItem icon="edit" onSelect={() => edit('rename')}>
          重命名
        </MenuItem>
        {depth === 0 ? (
          <MenuItem icon="add" onSelect={() => edit('add')}>
            {dimension ? '添加标签' : '添加小类'}
          </MenuItem>
        ) : null}
        <MenuItem icon="settings" onSelect={() => openDialog('rules')}>
          {dimension ? '维度设置' : '判断说明'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={previous === undefined}
          icon="move-up"
          onSelect={() => previous && void actions.change(tag, { position: previous.position })}
        >
          上移
        </MenuItem>
        <MenuItem
          disabled={next === undefined}
          icon="move-down"
          onSelect={() => next && void actions.change(tag, { position: next.position })}
        >
          下移
        </MenuItem>
        <MenuSeparator />
        <MenuItem destructive icon="delete" onSelect={() => openDialog('delete')}>
          删除
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

/** 新维度在分组区就地编辑，保存后由真实维度卡接替。 */
function CreateDimensionForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const fieldId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  return (
    <form
      className="tag-admin-prototype__create-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && name.trim()) void onSubmit(name.trim())
      }}
    >
      <label className="sr-only" htmlFor={fieldId}>
        维度名称
      </label>
      <Input
        className="rounded-sm"
        disabled={busy}
        id={fieldId}
        maxLength={50}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder="例如：投放目标"
        ref={inputRef}
        value={name}
      />
      <div className="tag-admin-prototype__create-actions">
        <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
          取消
        </Button>
        <Button
          disabled={!name.trim()}
          loading={busy}
          size="md"
          type="submit"
          variant={name.trim() ? 'inverted' : 'tonal'}
        >
          创建维度
        </Button>
      </div>
    </form>
  )
}

function NameForm({
  label,
  placeholder,
  busy,
  onSubmit,
  onCancel,
  initialValue = '',
  focus = false,
  rename = false,
}: {
  label: string
  placeholder: string
  busy: boolean
  onSubmit: (name: string) => Promise<boolean>
  onCancel: () => void
  initialValue?: string
  focus?: boolean
  rename?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focus) return
    inputRef.current?.focus()
    if (rename) inputRef.current?.select()
  }, [focus, rename])

  return (
    <form
      className="tag-admin-prototype__name-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || !value.trim()) return
        if (rename && value.trim() === initialValue) onCancel()
        else void onSubmit(value.trim())
      }}
    >
      <Input
        aria-label={label}
        className="tag-admin-prototype__name-input"
        disabled={busy}
        maxLength={50}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            if (event.key === 'Enter') event.preventDefault()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        placeholder={placeholder}
        ref={inputRef}
        value={value}
      />
      <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
        取消
      </Button>
      <Button
        disabled={!value.trim()}
        loading={busy}
        size="md"
        type="submit"
        variant={value.trim() ? 'inverted' : 'outlined'}
      >
        {rename ? '保存' : '添加'}
      </Button>
    </form>
  )
}

function RulesEditor({
  tag,
  dimension,
  busy,
  onSave,
  onCancel,
}: {
  tag: LibraryTag
  dimension: boolean
  busy: boolean
  onSave: (changes: LibraryTagUpdateIn) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(tag.name)
  const [guide, setGuide] = useState(tag.guide ?? '')
  const [autoFill, setAutoFill] = useState(() => isAiDimension(tag))
  const nameId = useId()
  const guideId = useId()

  return (
    <>
      <DialogHeader closeLabel="关闭设置" title={dimension ? '维度设置' : '标签设置'} />
      <DialogBody>
        <form
          className="tag-admin-prototype__rules"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || !name.trim()) return
            void onSave({
              ...(dimension ? { autoFill: autoFill ? 'ai' : null } : {}),
              guide: guide.trim() || null,
              name: name.trim(),
            })
          }}
        >
          <label className="tag-admin-prototype__field" htmlFor={nameId}>
            <span>{dimension ? '维度名称' : '标签名称'}</span>
            <Input
              disabled={busy}
              id={nameId}
              maxLength={50}
              onChange={(event) => setName(event.currentTarget.value)}
              value={name}
            />
          </label>
          {dimension ? (
            <div className="tag-admin-prototype__rule-mode">
              <div>
                <p>AI 自动打标</p>
                <span>开启后，AI 将根据判断说明选择这个维度的标签</span>
              </div>
              <button
                aria-checked={autoFill}
                aria-label="AI 自动打标"
                className="tag-admin-prototype__switch ui-focus"
                disabled={busy}
                onClick={() => setAutoFill(!autoFill)}
                role="switch"
                type="button"
              >
                <span />
              </button>
            </div>
          ) : null}
          <label className="tag-admin-prototype__field" htmlFor={guideId}>
            <span>判断说明</span>
            <Textarea
              disabled={busy}
              id={guideId}
              maxLength={1000}
              onChange={(event) => setGuide(event.currentTarget.value)}
              placeholder="说明如何判断，打标时会一并提供给 AI"
              rows={4}
              value={guide}
            />
          </label>
          <p className="tag-admin-prototype__hint">{RETAG_HINT}</p>
          <div className="tag-admin-prototype__dialog-actions">
            <Button disabled={busy} onClick={onCancel} size="md" variant="ghost">
              取消
            </Button>
            <Button
              disabled={!name.trim()}
              loading={busy}
              size="md"
              type="submit"
              variant="inverted"
            >
              保存
            </Button>
          </div>
        </form>
      </DialogBody>
    </>
  )
}
