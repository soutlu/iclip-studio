import { useQueryClient } from '@tanstack/react-query'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/field'
import { ListError, ListPending } from '@/shared/ui/list-state'
import { MarkdownEditor } from '@/shared/ui/markdown-editor'
import { toast } from '@/shared/ui/toast'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import {
  fileLabel,
  isMarkdownPath,
  readDescription,
  referencePath,
  SKILL_MD,
  skillBody,
  sortSkillPaths,
  withDescription,
  withSkillBody,
} from '../skill-files'
import {
  deleteSkillFile,
  renameSkillFile,
  skillQueryKeys,
  updateSkillDisplayName,
  usePublishSkill,
  useRefreshSkill,
  useSkillDetail,
  useSkillFile,
  writeSkillFile,
  type DraftFile,
  type SkillDetail,
} from '../skills.api'
import { PanelShell } from './panel-shell'
import { ADD_KEY, KEEP_KEY, NAME_KEY, SkillFileTabs, type FileTabsMode } from './skill-file-tabs'

/** 一个文件还没保存的内容；`baseHash` 是改动所基于的 hash，null 是还没存到服务端的新文件。 */
type Edit = { content: string; baseHash: string | null }

const sentences = (messages: string[]): string | null =>
  messages.length === 0
    ? null
    : messages.length === 1
      ? (messages[0] ?? null)
      : messages.map((message) => `${message}。`).join('')

type SkillEditorProps = {
  skillId: string
  /** 返回上一页（技能库、选技能）或收起面板。 */
  onBack: () => void
  /** 绑在当前 Agent 上时可以从它移除；不给就是没绑。 */
  onRemove: (() => void) | undefined
}

/**
 * 编辑一个技能的草稿：标题是显示名，副标题是 `SKILL.md` frontmatter 里的说明，下面是文件页签与编辑器。
 * 文件内容的改动先留在本地，「保存草稿」时逐个写回并带上读到的 hash；改名、删除与新建页签当场生效
 * （没保存过的新文件只在本地改）。「发布技能」先存上没保存的改动，再发布服务端的草稿。
 */
export function SkillEditor({ onBack, onRemove, skillId }: SkillEditorProps) {
  const queryClient = useQueryClient()
  const detail = useSkillDetail(skillId)
  const publish = usePublishSkill()
  const refresh = useRefreshSkill()
  const baseId = useId()
  const [active, setActive] = useState(SKILL_MD)
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [title, setTitle] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<FileTabsMode>(null)
  const [fileName, setFileName] = useState('')
  const [fileNameError, setFileNameError] = useState<string | null>(null)
  const [filePending, setFilePending] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLInputElement>(null)

  // 页签行在富文本与纯文本之间切换时会重新挂载，要聚焦的元素记下来，提交后再放焦点。
  const elementsRef = useRef(new Map<string, HTMLElement>())
  const focusRequestRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const key = focusRequestRef.current
    if (key === null) return
    const element = elementsRef.current.get(key)
    if (element === undefined) return
    focusRequestRef.current = null
    element.focus()
    if (element instanceof HTMLInputElement) element.select()
  })
  const registerElement = (key: string, element: HTMLElement | null) => {
    if (element === null) elementsRef.current.delete(key)
    else elementsRef.current.set(key, element)
  }

  const serverPaths = detail.data?.draftFiles.map((file) => file.path) ?? []
  const onServer = (path: string) => serverPaths.includes(path)
  const skillMd = useSkillFile(skillId, SKILL_MD, true)
  const activeFile = useSkillFile(skillId, active, active !== SKILL_MD && onServer(active))

  const fileKey = (path: string) => skillQueryKeys.file(skillId, path)
  const loaded = (path: string) => queryClient.getQueryData<DraftFile>(fileKey(path))
  const patchDetail = (change: (detail: SkillDetail) => SkillDetail) =>
    queryClient.setQueryData<SkillDetail>(skillQueryKeys.detail(skillId), (current) =>
      current === undefined ? current : change(current),
    )

  /** 改一个文件；改回与读到的一样就不再算改过（新文件除外）。 */
  const updateFile = (path: string, next: (current: string) => string) => {
    setEdits((previous) => {
      const base = loaded(path)
      const { [path]: edit, ...rest } = previous
      const current = edit?.content ?? base?.content
      if (current === undefined) return previous
      const content = next(current)
      if (edit?.baseHash === null) return { ...rest, [path]: { baseHash: null, content } }
      if (base === undefined) return previous
      if (content === base.content) return rest
      return { ...rest, [path]: { baseHash: edit?.baseHash ?? base.hash, content } }
    })
    setNotice(null)
  }

  const hashOf = (path: string) =>
    edits[path]?.baseHash ??
    loaded(path)?.hash ??
    detail.data?.draftFiles.find((file) => file.path === path)?.hash ??
    ''

  const paths = sortSkillPaths(new Set([...serverPaths, ...Object.keys(edits)]))
  const skillMdContent = edits[SKILL_MD]?.content ?? skillMd.data?.content
  const description = skillMdContent === undefined ? '' : (readDescription(skillMdContent) ?? '')
  const titleValue = title ?? detail.data?.displayName ?? ''
  const titleDirty =
    title !== null && detail.data !== undefined && title.trim() !== detail.data.displayName
  const dirty = Object.keys(edits).length > 0 || titleDirty
  const busy = saving || publish.isPending || filePending
  const unpublished = (detail.data?.hasUnpublishedChanges ?? false) || dirty

  const select = (path: string) => {
    setActive(path)
    setMode(null)
    setFileNameError(null)
    focusRequestRef.current = path
  }

  const startName = (next: FileTabsMode & { type: 'add' | 'rename' }) => {
    setMode(next)
    setFileName(next.type === 'rename' ? fileLabel(next.path) : '')
    setFileNameError(null)
    focusRequestRef.current = NAME_KEY
  }

  const cancelFileAction = () => {
    focusRequestRef.current = mode?.type === 'add' ? ADD_KEY : (mode?.path ?? active)
    setMode(null)
    setFileNameError(null)
  }

  const finishFileAction = (path: string) => {
    setMode(null)
    setFileNameError(null)
    setActive(path)
    focusRequestRef.current = path
  }

  const moveEdit = (from: string, to: string) =>
    setEdits(({ [from]: edit, ...rest }) => (edit === undefined ? rest : { ...rest, [to]: edit }))

  const applyFileName = async () => {
    if (mode === null || mode.type === 'delete' || filePending) return
    const previous = mode.type === 'rename' ? mode.path : undefined
    const result = referencePath(fileName, paths, previous)
    if ('error' in result) {
      setFileNameError(result.error)
      return
    }
    const to = result.path
    if (mode.type === 'add') {
      setEdits((current) => ({ ...current, [to]: { baseHash: null, content: '' } }))
      finishFileAction(to)
      return
    }
    const from = mode.path
    if (to === from) return finishFileAction(from)
    // 还没存到服务端的新文件只在本地改名。
    if (!onServer(from)) {
      moveEdit(from, to)
      return finishFileAction(to)
    }
    setFilePending(true)
    try {
      const renamed = await renameSkillFile(skillId, from, to, hashOf(from))
      queryClient.setQueryData(fileKey(to), renamed)
      queryClient.removeQueries({ exact: true, queryKey: fileKey(from) })
      patchDetail((current) => ({
        ...current,
        draftFiles: current.draftFiles.map((file) =>
          file.path === from ? { ...file, path: to } : file,
        ),
      }))
      // 改名不改内容与 hash，没保存的改动跟着搬过去。
      moveEdit(from, to)
      finishFileAction(to)
      void refresh(skillId)
    } catch (error) {
      setFileNameError(errorMessageOf(error, '重命名失败，请重试'))
      focusRequestRef.current = NAME_KEY
    } finally {
      setFilePending(false)
    }
  }

  const confirmDelete = async () => {
    if (mode?.type !== 'delete' || filePending) return
    const { path } = mode
    if (onServer(path)) {
      setFilePending(true)
      try {
        await deleteSkillFile(skillId, path, hashOf(path))
      } catch (error) {
        setNotice(errorMessageOf(error, '删除失败，请重试删除'))
        setMode(null)
        focusRequestRef.current = path
        return
      } finally {
        setFilePending(false)
      }
      queryClient.removeQueries({ exact: true, queryKey: fileKey(path) })
      patchDetail((current) => ({
        ...current,
        draftFiles: current.draftFiles.filter((file) => file.path !== path),
      }))
      void refresh(skillId)
    }
    setEdits(({ [path]: _deleted, ...rest }) => rest)
    finishFileAction(SKILL_MD)
  }

  /** 存上没保存的改动：逐个文件写回，最后改显示名。全部成功交回 true。 */
  const save = async (): Promise<boolean> => {
    if (detail.data === undefined) return false
    // 只查这次要存的：显示名改过才查名称，SKILL.md 改过才查说明。
    const problems: typeof errors = {}
    if (title !== null && title.trim() === '') problems.title = '请填写技能名称'
    if (edits[SKILL_MD] !== undefined && description.trim() === '')
      problems.description = '请填写简短说明'
    setErrors(problems)
    if (problems.title !== undefined || problems.description !== undefined) {
      ;(problems.title !== undefined ? titleRef : descriptionRef).current?.focus()
      return false
    }
    setNotice(null)
    setSaving(true)
    const messages: string[] = []
    let ok = true
    for (const path of sortSkillPaths(Object.keys(edits))) {
      const edit = edits[path]
      if (edit === undefined) continue
      try {
        const saved = await writeSkillFile(skillId, path, edit.content, edit.baseHash)
        queryClient.setQueryData(fileKey(path), saved)
        // 保存途中又改了的留着，基于刚存下的 hash。
        setEdits(({ [path]: current, ...rest }) =>
          current === undefined || current.content === edit.content
            ? rest
            : { ...rest, [path]: { ...current, baseHash: saved.hash } },
        )
      } catch (error) {
        ok = false
        const label = fileLabel(path)
        if (error instanceof ApiError && error.status === 409) {
          // 库里的已经变了：丢掉这一个文件的改动、读回最新的，别的文件接着存。
          setEdits(({ [path]: _stale, ...rest }) => rest)
          void queryClient.invalidateQueries({ exact: true, queryKey: fileKey(path) })
          messages.push(
            edit.baseHash === null
              ? `${label} 已有同名文件，已读取它的内容；刚才新建的内容已丢弃`
              : `${label} 已被别人修改，已读取最新内容；刚才对它的修改已丢弃，请重新修改后保存`,
          )
          continue
        }
        messages.push(
          error instanceof ApiError && error.status === 413
            ? `${label} 超过大小上限；单个文件不超过 1 MB，全部文件合计不超过 5 MB`
            : errorMessageOf(error, `${label} 保存失败，请重试保存`),
        )
        break
      }
    }
    if (titleDirty) {
      try {
        const updated = await updateSkillDisplayName(skillId, titleValue.trim())
        queryClient.setQueryData(skillQueryKeys.detail(skillId), updated)
        setTitle(null)
      } catch (error) {
        ok = false
        messages.push(errorMessageOf(error, '技能名称保存失败，请重试保存'))
      }
    }
    await refresh(skillId)
    setSaving(false)
    setNotice(sentences(messages))
    return ok
  }

  const onSave = async () => {
    if (await save()) toast.success('草稿已保存')
  }

  const onPublish = async () => {
    if (dirty && !(await save())) return
    setNotice(null)
    try {
      const version = await publish.mutateAsync(skillId)
      toast.success(`已发布 v${version.version}`)
    } catch (error) {
      setNotice(errorMessageOf(error, '发布失败，请重试发布'))
    }
  }

  if (detail.isPending || detail.isError)
    return (
      <PanelShell onClose={onBack} title="编辑技能">
        {detail.isPending ? (
          <ListPending label="正在读取技能…" />
        ) : (
          <ListError message={detail.error.message} onRetry={() => void detail.refetch()} />
        )}
      </PanelShell>
    )

  const skill = detail.data
  const tabs = (
    <SkillFileTabs
      active={active}
      disabled={busy}
      mode={mode}
      name={fileName}
      nameError={fileNameError}
      onApply={() => void applyFileName()}
      onCancel={cancelFileAction}
      onConfirmDelete={() => void confirmDelete()}
      onNameChange={(value) => {
        setFileName(value)
        setFileNameError(null)
      }}
      onSelect={select}
      onStartAdd={() => startName({ type: 'add' })}
      onStartDelete={(path) => {
        setMode({ path, type: 'delete' })
        focusRequestRef.current = KEEP_KEY
      }}
      onStartRename={(path) => startName({ path, type: 'rename' })}
      paths={paths}
      pending={filePending}
      registerElement={registerElement}
    />
  )

  const activeQuery = active === SKILL_MD ? skillMd : activeFile
  const activeContent =
    active === SKILL_MD ? skillMdContent : (edits[active]?.content ?? activeFile.data?.content)
  let body: ReactNode
  if (activeContent !== undefined && isMarkdownPath(active)) {
    body = (
      <MarkdownEditor
        ariaLabel="文件内容"
        className="flex-1 pb-4"
        leading={tabs}
        onChange={(markdown) =>
          updateFile(active, (current) =>
            active === SKILL_MD ? withSkillBody(current, markdown) : markdown,
          )
        }
        placeholder="写下这个文件的内容"
        value={active === SKILL_MD ? skillBody(activeContent) : activeContent}
      />
    )
  } else {
    // 不是 markdown 的参考文件（json、yaml、txt 等）用纯文本编辑；读取中、读取失败也在这一行下面。
    body = (
      <div className="flex min-h-0 flex-1 flex-col pb-4">
        <div className="-ml-1 flex min-h-(--control-height-sm) shrink-0 items-center gap-3 pb-2">
          <div className="min-w-0 flex-1">{tabs}</div>
        </div>
        {activeContent !== undefined ? (
          <Textarea
            aria-label="文件内容"
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-1 tabular-nums"
            onChange={(event) => {
              const text = event.currentTarget.value
              updateFile(active, () => text)
            }}
            placeholder="写下这个文件的内容"
            spellCheck={false}
            value={activeContent}
          />
        ) : activeQuery.isError ? (
          <ListError
            message={activeQuery.error.message}
            onRetry={() => void activeQuery.refetch()}
          />
        ) : (
          <ListPending label="正在读取文件…" />
        )}
      </div>
    )
  }

  const draftDot = skill.latestVersion !== null && unpublished
  const pillLabel =
    skill.latestVersion === null
      ? '尚未发布'
      : dirty
        ? `已发布 v${skill.latestVersion}，有未保存的修改`
        : unpublished
          ? `已发布 v${skill.latestVersion}，草稿有未发布的修改`
          : `已发布 v${skill.latestVersion}`

  const inlineClass =
    'w-full rounded-sm bg-transparent px-2 py-0.5 ui-motion-s transition-colors placeholder:text-on-surface-faint hover:bg-state-hover focus:bg-state-hover focus-visible:outline-0 disabled:cursor-default aria-invalid:ring-1 aria-invalid:ring-error aria-invalid:ring-inset'
  const fieldError = errors.title ?? errors.description

  return (
    <PanelShell
      actions={
        <>
          <TooltipRoot>
            <TooltipTrigger asChild>
              <span
                aria-label={pillLabel}
                className="inline-flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-label text-on-surface tabular-nums ring-1 ring-border ring-inset"
                role="img"
              >
                {skill.latestVersion === null ? '草稿' : `v${skill.latestVersion}`}
                {draftDot ? (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-on-surface-variant"
                  />
                ) : null}
              </span>
            </TooltipTrigger>
            <TooltipContent>{pillLabel}</TooltipContent>
          </TooltipRoot>
          {onRemove === undefined ? null : (
            <IconButton
              disabled={busy}
              label="从当前 Agent 移除"
              name="delete"
              onClick={onRemove}
              size="md"
            />
          )}
        </>
      }
      footer={
        <>
          {notice === null ? null : (
            <p className="mr-auto min-w-0 text-body-sm text-error" role="alert">
              {notice}
            </p>
          )}
          <Button
            disabled={!dirty || busy}
            loading={saving && !publish.isPending}
            onClick={() => void onSave()}
            size="md"
            variant="ghost"
          >
            保存草稿
          </Button>
          <Button
            disabled={!unpublished || busy}
            loading={publish.isPending}
            onClick={() => void onPublish()}
            size="md"
          >
            发布技能
          </Button>
        </>
      }
      onClose={onBack}
      scroll={false}
      title="编辑技能"
    >
      <div className="-mx-2 flex shrink-0 flex-col gap-0.5 pt-1">
        <input
          aria-describedby={errors.title === undefined ? undefined : `${baseId}-error`}
          aria-invalid={errors.title !== undefined}
          aria-label="技能名称"
          className={cn(inlineClass, 'text-title-lg font-semibold text-on-surface')}
          maxLength={100}
          onChange={(event) => {
            setTitle(event.currentTarget.value)
            setErrors(({ title: _title, ...rest }) => rest)
            setNotice(null)
          }}
          placeholder="技能名称"
          ref={titleRef}
          value={titleValue}
        />
        <input
          aria-describedby={errors.description === undefined ? undefined : `${baseId}-error`}
          aria-invalid={errors.description !== undefined}
          aria-label="简短说明"
          className={cn(inlineClass, 'text-body text-on-surface-variant')}
          disabled={skillMdContent === undefined}
          maxLength={1024}
          onChange={(event) => {
            const text = event.currentTarget.value
            updateFile(SKILL_MD, (current) => withDescription(current, text, skill.name))
            setErrors(({ description: _description, ...rest }) => rest)
          }}
          placeholder="一句话说明这个技能做什么"
          ref={descriptionRef}
          value={description}
        />
        {fieldError === undefined ? null : (
          <p className="px-2 text-label text-error" id={`${baseId}-error`} role="alert">
            {fieldError}
          </p>
        )}
      </div>
      <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-hairline pt-3">{body}</div>
    </PanelShell>
  )
}
