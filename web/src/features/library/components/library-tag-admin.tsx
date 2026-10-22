/** 交互原型：在现有标签管理中验证宽区编辑、三级树与连续录入。 */
import { useId, useRef, useState, type CSSProperties } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { LibraryTagUpdateIn } from '@/shared/api/generated/types.gen'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { useFilterBar } from '@/shared/ui/filter-bar'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import {
  useCreateLibraryTag,
  useDeleteLibraryTag,
  useUpdateLibraryTag,
} from '../library-tag-admin.api'
import { isAiDimension, type LibraryTag, type TagIndex } from '../library-tags'
import { isTagTreePrototype } from '../tag-tree-prototype'
import { CreateDimensionForm, NameForm, RulesEditor } from './library-tag-admin-forms'
import './library-tag-admin.css'

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

type Editing = { kind: 'add' | 'rename'; id: string; focus: boolean; position?: number } | null
type DialogState = { kind: 'rules' | 'delete'; tag: LibraryTag; dimension: boolean } | null
const RETAG_HINT = '修改仅影响之后的打标，已有标签不会重打。'

/** 连续分组保持按列阅读的全局顺序，五个维度分为 2 / 2 / 1。 */
const dimensionColumnsOf = (dimensions: readonly LibraryTag[]) => {
  const perColumn = Math.floor(dimensions.length / 3)
  const remainder = dimensions.length % 3
  return [0, 1, 2].map((column) => {
    const start = column * perColumn + Math.min(column, remainder)
    const size = perColumn + (column < remainder ? 1 : 0)
    return { dimensions: dimensions.slice(start, start + size), id: column }
  })
}

const matchesSearch = (tag: LibraryTag, query: string): boolean =>
  tag.name.toLocaleLowerCase().includes(query) ||
  tag.children.some((child) => matchesSearch(child, query))

type Actions = {
  busy: boolean
  editing: Editing
  error: string | null
  edit: (next: Editing) => void
  openDialog: (next: DialogState) => void
  add: (name: string, parentId: string | null) => Promise<boolean>
  change: (tag: LibraryTag, changes: LibraryTagUpdateIn) => Promise<boolean>
}

export function LibraryTagAdmin({ index, onClose }: { index: TagIndex; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const [focusedId, setFocusedId] = useState<string | null>(() =>
    isTagTreePrototype()
      ? (index.dimensions.find((item) => item.name === '场景')?.id ?? null)
      : null,
  )
  const [formError, setFormError] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [editing, setEditing] = useState<Editing>(() => {
    const emptyDimension = index.dimensions.find((dimension) => dimension.children.length === 0)
    return emptyDimension === undefined
      ? null
      : { focus: false, id: emptyDimension.id, kind: 'add' }
  })
  const [dialog, setDialog] = useState<DialogState>(null)
  const [creatingDimension, setCreatingDimension] = useState(false)
  const addDimensionRef = useRef<HTMLButtonElement>(null)
  const closeCreate = () => {
    setCreatingDimension(false)
    addDimensionRef.current?.focus()
  }
  const [initiallyExpanded] = useState(
    () =>
      new Set(
        index.dimensions.flatMap((dimension) =>
          dimension.children
            .filter((tag) => tag.children.length > 0)
            .slice(0, 1)
            .flatMap((tag) => [tag.id, ...tag.children.slice(0, 1).map((child) => child.id)]),
        ),
      ),
  )
  const create = useCreateLibraryTag()
  const update = useUpdateLibraryTag()
  const remove = useDeleteLibraryTag()
  const busy = create.isPending || update.isPending || remove.isPending
  const query = search.trim().toLocaleLowerCase()
  const hasMatches = index.dimensions.some((tag) => matchesSearch(tag, query))
  const columns = dimensionColumnsOf(index.dimensions)
  const focusedDimension = index.dimensions.find((dimension) => dimension.id === focusedId)
  const focusDimension = (id: string | null) => {
    setFocusedId(id)
    setEditing(null)
    setFormError(null)
    panelRef.current?.scrollIntoView({ block: 'start' })
  }

  const actions: Actions = {
    add: async (name, parentId) => {
      setFormError(null)
      try {
        const added = await create.mutateAsync({
          name,
          parentId,
          position: parentId === null ? 0 : (editing?.position ?? 0),
        })
        if (parentId === null) setEditing(null)
        else
          setEditing((current) =>
            current?.kind === 'add' && current.id === parentId
              ? { ...current, position: added.position + 1 }
              : current,
          )
        return true
      } catch (error) {
        const message = errorMessageOf(error, '添加失败，请重试')
        if (parentId === null) toast.error(message)
        else setFormError(message)
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
    edit: (next) => {
      setFormError(null)
      setEditing(next)
    },
    editing,
    error: formError,
    openDialog: setDialog,
  }

  return (
    <section aria-label="管理标签" className="tag-admin" ref={panelRef}>
      <div className="tag-admin__toolbar">
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
          wrapperClassName="tag-admin__search"
        />
        {focusedDimension === undefined ? (
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
        ) : null}
        <Button
          className="tag-admin__done"
          onClick={focusedDimension ? () => focusDimension(null) : onClose}
          size="md"
          variant="inverted"
        >
          {focusedDimension ? '完成编辑' : '完成'}
        </Button>
      </div>

      {focusedDimension ? (
        <div className="tag-admin__focus-area">
          <div className="tag-admin__focus-nav">
            <Button
              leadingIcon="back"
              onClick={() => focusDimension(null)}
              size="md"
              variant="ghost"
            >
              全部维度
            </Button>
            <Icon decorative name="disclosure" size="xs" />
            <span>{focusedDimension.name}</span>
          </div>
          <DimensionCard
            actions={actions}
            dimension={focusedDimension}
            focused
            initiallyExpanded={initiallyExpanded}
            onFocus={focusDimension}
            query={query}
            siblings={index.dimensions}
          />
        </div>
      ) : hasMatches || creatingDimension ? (
        <div className="tag-admin__grid">
          {columns.map((column) => (
            <div className="tag-admin__column" key={column.id}>
              {column.id === 0 && creatingDimension ? (
                <section aria-label="新维度" className="tag-admin__card">
                  <div className="tag-admin__card-heading">
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
              {column.dimensions
                .filter((tag) => matchesSearch(tag, query))
                .map((dimension) => (
                  <DimensionCard
                    actions={actions}
                    dimension={dimension}
                    initiallyExpanded={initiallyExpanded}
                    key={dimension.id}
                    onFocus={focusDimension}
                    query={query}
                    siblings={index.dimensions}
                  />
                ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="tag-admin__empty" role="status">
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
                hint={RETAG_HINT}
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
                  <div className="tag-admin__dialog-actions">
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
  focused = false,
  onFocus,
}: {
  dimension: LibraryTag
  siblings: readonly LibraryTag[]
  query: string
  initiallyExpanded: ReadonlySet<string>
  actions: Actions
  focused?: boolean
  onFocus: (id: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const headingId = useId()
  const childQuery = dimension.name.toLocaleLowerCase().includes(query) ? '' : query
  const adding = actions.editing?.id === dimension.id && actions.editing.kind === 'add'
  const matching = adding
    ? dimension.children
    : dimension.children.filter((tag) => matchesSearch(tag, childQuery))
  const children = focused || showAll || query ? matching : matching.slice(0, 10)
  const insertion = adding ? (actions.editing?.position ?? 0) : 0
  const renaming = actions.editing?.id === dimension.id && actions.editing.kind === 'rename'

  return (
    <section
      aria-labelledby={headingId}
      className={cn('tag-admin__card', focused && 'tag-admin__card--focused')}
    >
      <div className="tag-admin__card-heading">
        <h3 id={headingId}>{dimension.name}</h3>
        <span className="tag-admin__mode">{isAiDimension(dimension) ? '自动' : '人工'}</span>
        <div className="tag-admin__card-tools">
          {!focused ? (
            <Button
              aria-label={`展开编辑${dimension.name}`}
              className="tag-admin__expand-editor"
              onClick={() => onFocus(dimension.id)}
              size="md"
              variant="ghost"
            >
              展开编辑
            </Button>
          ) : null}
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
      {dimension.children.length > 0 || adding ? (
        <>
          <div aria-hidden className="tag-admin__count-head">
            <span />
            <span>灵感库</span>
            <span>爆款</span>
            <span />
          </div>
          <ul aria-label={`${dimension.name}的标签`} className="tag-admin__list">
            {children.slice(0, insertion).map((tag) => (
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
            {adding ? (
              <li className="tag-admin__new-row" key="new-tag">
                <NameForm
                  busy={actions.busy}
                  continuous
                  error={actions.error}
                  focus={actions.editing?.focus ?? false}
                  label={`${dimension.name}的标签名称`}
                  onCancel={() => actions.edit(null)}
                  onSubmit={async (name) => {
                    const added = await actions.add(name, dimension.id)
                    if (added) setShowAll(true)
                    return added
                  }}
                  placeholder="输入标签名称"
                />
              </li>
            ) : null}
            {children.slice(insertion).map((tag) => (
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
          {!focused && !query && matching.length > 10 ? (
            <button
              aria-expanded={showAll}
              className="tag-admin__show-all ui-focus"
              onClick={() => setShowAll(!showAll)}
              type="button"
            >
              {showAll ? '收起' : `查看全部 ${matching.length} 个`}
              <Icon decorative name={showAll ? 'collapse' : 'expand'} size="xs" />
            </button>
          ) : null}
        </>
      ) : (
        <p className="tag-admin__card-empty">暂无标签，请添加标签</p>
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
  depth: number
  query: string
  initiallyExpanded: ReadonlySet<string>
  actions: Actions
}) {
  const [open, setOpen] = useState(() => initiallyExpanded.has(tag.id))
  const adding = actions.editing?.id === tag.id && actions.editing.kind === 'add'
  const renaming = actions.editing?.id === tag.id && actions.editing.kind === 'rename'
  const hasChildren = tag.children.length > 0
  const expanded = open || Boolean(query) || adding
  const children =
    adding || tag.name.toLocaleLowerCase().includes(query)
      ? tag.children
      : tag.children.filter((child) => matchesSearch(child, query))
  const insertion = adding ? (actions.editing?.position ?? 0) : 0
  const childRow = (child: LibraryTag) => (
    <TagRow
      actions={actions}
      depth={depth + 1}
      initiallyExpanded={initiallyExpanded}
      key={child.id}
      query={query}
      siblings={tag.children}
      tag={child}
    />
  )

  return (
    <li
      className={cn('tag-admin__item', hasChildren && 'tag-admin__branch')}
      style={{ '--tag-depth': depth } as CSSProperties}
    >
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
        <div className={cn('tag-admin__row', adding && 'tag-admin__row--active')}>
          {hasChildren ? (
            <button
              aria-expanded={expanded}
              className="tag-admin__branch-label ui-focus"
              onClick={() => setOpen(!open)}
              type="button"
            >
              <Icon decorative name={expanded ? 'expand' : 'disclosure'} size="xs" />
              <span>{tag.name}</span>
            </button>
          ) : (
            <span className="tag-admin__name">{tag.name}</span>
          )}
          <span
            aria-label={`灵感库 ${tag.counts.references} 条`}
            className={cn('tag-admin__count', tag.counts.references === 0 && 'is-zero')}
          >
            {tag.counts.references}
          </span>
          <span
            aria-label={`爆款素材库 ${tag.counts.hitCases} 条`}
            className={cn('tag-admin__count', tag.counts.hitCases === 0 && 'is-zero')}
          >
            {tag.counts.hitCases}
          </span>
          <div className="tag-admin__row-tools">
            {depth < 2 ? (
              <IconButton
                disabled={actions.busy}
                label={`给${tag.name}添加下级`}
                name="add"
                onClick={() => actions.edit({ focus: true, id: tag.id, kind: 'add', position: 0 })}
                size="xs"
              />
            ) : null}
            <TagMenu actions={actions} depth={depth} siblings={siblings} tag={tag} />
          </div>
        </div>
      )}
      {expanded && (hasChildren || adding) ? (
        <ul aria-label={`${tag.name}的小类`} className="tag-admin__children">
          {children.slice(0, insertion).map(childRow)}
          {adding ? (
            <li className="tag-admin__child-form" key="new-tag">
              <NameForm
                busy={actions.busy}
                continuous
                error={actions.error}
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
            </li>
          ) : null}
          {children.slice(insertion).map(childRow)}
        </ul>
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
  depth?: number
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
          className={cn('tag-admin__more', dimension && 'is-dimension')}
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
        {depth < 2 ? (
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
          同级上移
        </MenuItem>
        <MenuItem
          disabled={next === undefined}
          icon="move-down"
          onSelect={() => next && void actions.change(tag, { position: next.position })}
        >
          同级下移
        </MenuItem>
        <MenuSeparator />
        <MenuItem destructive icon="delete" onSelect={() => openDialog('delete')}>
          删除
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}
