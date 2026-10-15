/** 品牌片头片尾：所有读者可预览在用模板，治理者维护名称与启停状态。 */
import { useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  brandTemplateQueryKeys,
  createBrandTemplate,
  updateBrandTemplate,
  useBrandTemplates,
  type BrandTemplate,
} from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input, Select } from '@/shared/ui/field'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { Tag } from '@/shared/ui/tag'
import { toast } from '@/shared/ui/toast'
import { LibraryPageHeader } from './library-page-header'

export type BrandTemplateScope = {
  q: string
  position: 'intro' | 'outro' | undefined
  includeDisabled: boolean
}
type Props = {
  tabs: ReactNode
  canManage: boolean
  canUpload: boolean
  scope: BrandTemplateScope
  onScopeChange: (scope: BrandTemplateScope) => void
}
type Editor = { kind: 'create' } | { kind: 'rename'; template: BrandTemplate }

export function BrandTemplatesRoute({ tabs, canManage, canUpload, scope, onScopeChange }: Props) {
  const queryClient = useQueryClient()
  const { position, includeDisabled, q: search } = scope
  const [editor, setEditor] = useState<Editor | null>(null)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = useBrandTemplates({
    ...(position === undefined ? {} : { position }),
    includeDisabled: canManage && includeDisabled,
  })
  const items =
    query.data?.items.filter((item) =>
      item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    ) ?? []
  const refresh = () => queryClient.invalidateQueries({ queryKey: brandTemplateQueryKeys.all })
  const toggle = async (template: BrandTemplate) => {
    if (!canManage || updating !== null) return
    setUpdating(template.id)
    setError(null)
    try {
      const disabled = template.disabledAt === null
      await updateBrandTemplate(template.id, { disabled })
      await refresh()
      toast.success(disabled ? '模板已停用，已有整片不受影响' : '模板已恢复使用')
    } catch (cause) {
      setError(errorMessageOf(cause, '更新品牌模板失败，请重试'))
    } finally {
      setUpdating(null)
    }
  }
  return (
    <main aria-label="品牌模板" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col px-4 pt-12 pb-10 sm:px-(--layout-list-page-gutter) sm:pt-14">
        <LibraryPageHeader
          description="为整片选择统一的品牌片头与片尾，模板保留自己的声音。"
          tabs={tabs}
          search={{
            label: '搜索品牌模板',
            placeholder: '搜索模板名称…',
            value: search,
            onSearch: (q) => onScopeChange({ ...scope, q }),
          }}
          action={
            canManage && canUpload ? (
              <Button leadingIcon="upload" onClick={() => setEditor({ kind: 'create' })}>
                上传模板
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-3 py-4">
          <ChipGroup
            aria-label="模板位置"
            type="single"
            value={position ?? 'all'}
            onValueChange={(value) =>
              onScopeChange({
                ...scope,
                position: value === 'intro' || value === 'outro' ? value : undefined,
              })
            }
          >
            <FilterChip value="all">全部</FilterChip>
            <FilterChip value="intro">片头</FilterChip>
            <FilterChip value="outro">片尾</FilterChip>
          </ChipGroup>
          {canManage ? (
            <label className="inline-flex items-center gap-2 text-body-sm">
              <input
                checked={includeDisabled}
                onChange={(event) =>
                  onScopeChange({ ...scope, includeDisabled: event.currentTarget.checked })
                }
                type="checkbox"
                className="size-4 accent-primary ui-focus"
              />
              显示已停用
            </label>
          ) : null}
          {query.data === undefined ? null : (
            <span className="ml-auto text-body-sm text-on-surface-faint">
              共 {items.length} 个模板
            </span>
          )}
        </div>
        {error === null ? null : (
          <p className="pb-4 text-body-sm text-error" role="alert">
            {error}
          </p>
        )}
        {query.isPending ? (
          <ListPending label="正在读取品牌模板…" />
        ) : query.isError ? (
          <ListError
            message={errorMessageOf(query.error, '读取品牌模板失败')}
            onRetry={() => void query.refetch()}
          />
        ) : items.length === 0 ? (
          <ListEmpty>
            {search.trim() === ''
              ? '暂无可用模板，请联系管理员上传片头或片尾'
              : '暂无匹配的模板，请更换关键词'}
          </ListEmpty>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <TemplateCard
                key={item.id}
                item={item}
                canManage={canManage}
                busy={updating !== null}
                onPreview={() =>
                  setPreview({
                    kind: 'video',
                    name: item.name,
                    url: item.url,
                    poster: videoSnapshotUrl(item.url, 720),
                  })
                }
                onRename={() => setEditor({ kind: 'rename', template: item })}
                onToggle={() => void toggle(item)}
              />
            ))}
          </div>
        )}
      </div>
      {editor === null || !canManage ? null : (
        <TemplateEditor
          editor={editor}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await refresh()
            setEditor(null)
          }}
        />
      )}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </main>
  )
}

function TemplateCard({
  item,
  canManage,
  busy,
  onPreview,
  onRename,
  onToggle,
}: {
  item: BrandTemplate
  canManage: boolean
  busy: boolean
  onPreview: () => void
  onRename: () => void
  onToggle: () => void
}) {
  const [failed, setFailed] = useState(false)
  const poster = videoSnapshotUrl(item.url, 480)
  return (
    <article aria-label={item.name} className="flex min-w-0 flex-col">
      <button
        className="relative grid aspect-video ui-state cursor-pointer place-items-center overflow-hidden rounded-md bg-surface-container-low ui-focus"
        aria-label={`预览模板：${item.name}`}
        onClick={onPreview}
        type="button"
      >
        {poster === undefined || failed ? (
          <Icon decorative name="video" size="xl" />
        ) : (
          <img
            alt=""
            src={poster}
            className="size-full object-contain"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
        <span className="library-card-badge absolute bottom-2 left-2">
          {item.position === 'intro' ? '片头' : '片尾'} · {(item.durationMs / 1000).toFixed(1)} 秒
        </span>
      </button>
      <div className="flex flex-col gap-2 pt-3">
        <h3 className="line-clamp-2 text-body font-medium">{item.name}</h3>
        <p className="text-body-sm text-on-surface-variant">
          {item.width} × {item.height} · {item.hasAudio ? '带原声' : '无原声'}
        </p>
        {item.disabledAt === null ? null : (
          <div>
            <Tag>已停用</Tag>
          </div>
        )}
        {canManage ? (
          <div className="flex flex-wrap gap-1">
            <Button disabled={busy} onClick={onRename} size="md" variant="ghost">
              改名
            </Button>
            <Button disabled={busy} onClick={onToggle} size="md" variant="ghost">
              {item.disabledAt === null ? '停用' : '恢复使用'}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function TemplateEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const formId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(editor.kind === 'rename' ? editor.template.name : '')
  const [position, setPosition] = useState<'intro' | 'outro'>('intro')
  const [media, setMedia] = useState<{ file: File; uploadId: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (name.trim() === '') {
      setError('模板名称不能为空，请填写名称')
      return
    }
    if (editor.kind === 'create' && media === null) {
      setError('尚未选择视频，请选择片头或片尾文件')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (editor.kind === 'rename')
        await updateBrandTemplate(editor.template.id, { name: name.trim() })
      else if (media !== null) {
        const uploadId = media.uploadId ?? (await uploadMediaFile(media.file, 'video')).uploadId
        // 创建失败时保留已确认的上传，重试不重复上传视频。
        setMedia({ file: media.file, uploadId })
        await createBrandTemplate({ name: name.trim(), position, uploadId })
      }
      toast.success(editor.kind === 'rename' ? '模板名称已更新' : '品牌模板已创建')
      await onSaved()
    } catch (cause) {
      setError(errorMessageOf(cause, '保存模板失败，请重试'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader
          closeLabel="关闭模板编辑"
          title={editor.kind === 'rename' ? '修改模板名称' : '上传品牌模板'}
        />
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogBody className="flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-name`}>
              模板名称
              <Input
                id={`${formId}-name`}
                disabled={busy}
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                required
              />
            </label>
            {editor.kind === 'rename' ? null : (
              <>
                <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-position`}>
                  使用位置
                  <Select
                    id={`${formId}-position`}
                    disabled={busy}
                    value={position}
                    onChange={(event) =>
                      setPosition(event.currentTarget.value === 'outro' ? 'outro' : 'intro')
                    }
                  >
                    <option value="intro">片头</option>
                    <option value="outro">片尾</option>
                  </Select>
                </label>
                <div className="flex flex-col gap-2 text-body-sm">
                  <label htmlFor={`${formId}-file`}>模板视频</label>
                  <input
                    id={`${formId}-file`}
                    ref={fileRef}
                    className="sr-only"
                    accept={MEDIA_VIDEO_ACCEPT}
                    disabled={busy}
                    type="file"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      setMedia(file === undefined ? null : { file, uploadId: null })
                      if (file !== undefined && name.trim() === '')
                        setName(file.name.replace(/\.[^.]+$/, '').slice(0, 100))
                    }}
                  />
                  <div className="flex min-w-0 items-center gap-3">
                    <Button
                      type="button"
                      size="md"
                      variant="outlined"
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      选择视频
                    </Button>
                    <span className="min-w-0 truncate text-on-surface-variant">
                      {media?.file.name ?? '尚未选择视频'}
                    </span>
                  </div>
                </div>
                <p className="text-body-sm text-on-surface-variant">
                  每个模板最长 10 秒，保留视频自带的声音；请按需要的画幅分别上传。
                </p>
              </>
            )}
            {error === null ? null : (
              <p role="alert" className="text-body-sm text-error">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
              取消
            </Button>
            <Button loading={busy} type="submit">
              {busy ? '正在保存…' : '保存模板'}
            </Button>
          </DialogFooter>
        </form>
      </DialogSurface>
    </DialogRoot>
  )
}
