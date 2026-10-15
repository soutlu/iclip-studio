/** 字体与片头片尾共用资料库；治理者上传、修改名称和品牌、启停资源。 */
import { useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  BRAND_FONT_ACCEPT,
  brandTemplateQueryKeys,
  confirmBrandFont,
  createBrandTemplate,
  updateBrandTemplate,
  uploadBrandFontFile,
  useBrandTemplates,
  type BrandTemplate,
} from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { MEDIA_VIDEO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { normalizeCaptionText, usePreviewFont } from '@/shared/lib/use-preview-font'
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

type ResourceKind = 'font' | 'intro' | 'outro'
export type BrandTemplateScope = {
  q: string
  kind: ResourceKind | undefined
  brand: string | undefined
  includeDisabled: boolean
}
type Props = {
  tabs: ReactNode
  canManage: boolean
  canUpload: boolean
  scope: BrandTemplateScope
  onScopeChange: (scope: BrandTemplateScope) => void
}
type Editor = { kind: 'create' } | { kind: 'edit'; template: BrandTemplate }
const kindName = (kind: string) =>
  kind === 'font' ? '字体' : kind === 'intro' ? '片头' : kind === 'outro' ? '片尾' : '资源'
const isVideo = (item: BrandTemplate) => item.kind === 'intro' || item.kind === 'outro'
const hasVideoFacts = (item: BrandTemplate) =>
  item.width !== null && item.height !== null && item.durationMs !== null && item.hasAudio !== null

export function BrandTemplatesRoute({ tabs, canManage, canUpload, scope, onScopeChange }: Props) {
  const queryClient = useQueryClient()
  const { kind, brand, includeDisabled, q: search } = scope
  const [editor, setEditor] = useState<Editor | null>(null)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const [fontPreview, setFontPreview] = useState<BrandTemplate | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 列表本身不翻页；品牌选项始终来自全部可见资源，筛选后不丢掉其他品牌。
  const query = useBrandTemplates({ includeDisabled: canManage && includeDisabled })
  const items =
    query.data?.items.filter(
      (item) =>
        (kind === undefined || item.kind === kind) &&
        (brand === undefined || item.brand === brand) &&
        item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    ) ?? []
  const brands = [
    ...new Set([
      ...(query.data?.items.flatMap((item) => (item.brand === null ? [] : [item.brand])) ?? []),
      ...(brand === undefined ? [] : [brand]),
    ]),
  ].sort((left, right) => left.localeCompare(right))
  const refresh = () => queryClient.invalidateQueries({ queryKey: brandTemplateQueryKeys.all })
  const toggle = async (template: BrandTemplate) => {
    if (!canManage || updating !== null) return
    setUpdating(template.id)
    setError(null)
    try {
      const disabled = template.disabledAt === null
      await updateBrandTemplate(template.id, { disabled })
      await refresh()
      toast.success(disabled ? '资源已停用' : '资源已恢复使用')
    } catch (cause) {
      setError(errorMessageOf(cause, '更新品牌资源失败，请重试'))
    } finally {
      setUpdating(null)
    }
  }
  return (
    <main aria-label="品牌模板" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col px-4 pt-12 pb-10 sm:px-(--layout-list-page-gutter) sm:pt-14">
        <LibraryPageHeader
          tabs={tabs}
          search={{
            label: '搜索品牌资源',
            placeholder: '搜索名称…',
            value: search,
            onSearch: (q) => onScopeChange({ ...scope, q }),
          }}
          action={
            canManage && canUpload ? (
              <Button leadingIcon="upload" onClick={() => setEditor({ kind: 'create' })}>
                上传资源
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-3 py-4">
          <ChipGroup
            aria-label="资源类型"
            type="single"
            value={kind ?? 'all'}
            onValueChange={(value) =>
              onScopeChange({
                ...scope,
                kind:
                  value === 'font' || value === 'intro' || value === 'outro' ? value : undefined,
              })
            }
          >
            <FilterChip value="all">全部</FilterChip>
            <FilterChip value="font">字体</FilterChip>
            <FilterChip value="intro">片头</FilterChip>
            <FilterChip value="outro">片尾</FilterChip>
          </ChipGroup>
          <Select
            aria-label="筛选品牌"
            className="h-(--control-height-md) w-auto"
            value={brand ?? ''}
            onChange={(event) =>
              onScopeChange({ ...scope, brand: event.currentTarget.value || undefined })
            }
          >
            <option value="">全部品牌</option>
            {brands.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
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
              共 {items.length} 个资源
            </span>
          )}
        </div>
        {error === null ? null : (
          <p className="pb-4 text-body-sm text-error" role="alert">
            {error}
          </p>
        )}
        {query.isPending ? (
          <ListPending label="正在读取品牌资源…" />
        ) : query.isError ? (
          <ListError
            message={errorMessageOf(query.error, '读取品牌资源失败')}
            onRetry={() => void query.refetch()}
          />
        ) : items.length === 0 ? (
          <ListEmpty>
            {search.trim() === '' && kind === undefined && brand === undefined
              ? '暂无品牌资源，请联系管理员上传'
              : '暂无匹配资源，请调整筛选条件'}
          </ListEmpty>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <TemplateCard
                key={item.id}
                item={item}
                canManage={canManage}
                busy={updating !== null}
                onPreview={() => {
                  if (item.kind === 'font') setFontPreview(item)
                  else if (isVideo(item))
                    setPreview({
                      kind: 'video',
                      name: item.name,
                      url: item.url,
                      poster: videoSnapshotUrl(item.url, 720),
                    })
                }}
                onEdit={() => setEditor({ kind: 'edit', template: item })}
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
      {fontPreview === null ? null : (
        <FontPreviewDialog
          key={fontPreview.id}
          font={fontPreview}
          onClose={() => setFontPreview(null)}
        />
      )}
    </main>
  )
}

function TemplateCard({
  item,
  canManage,
  busy,
  onPreview,
  onEdit,
  onToggle,
}: {
  item: BrandTemplate
  canManage: boolean
  busy: boolean
  onPreview: () => void
  onEdit: () => void
  onToggle: () => void
}) {
  const [failed, setFailed] = useState(false)
  const font = usePreviewFont(item.kind === 'font' ? item : null, 'Aa')
  const poster = isVideo(item) ? videoSnapshotUrl(item.url, 480) : undefined
  return (
    <article aria-label={item.name} className="flex min-w-0 flex-col">
      <button
        className="relative grid aspect-video ui-state cursor-pointer place-items-center overflow-hidden rounded-md bg-surface-container-low ui-focus"
        aria-label={`预览资源：${item.name}`}
        onClick={onPreview}
        disabled={!isVideo(item) && item.kind !== 'font'}
        type="button"
      >
        {item.kind === 'font' ? (
          font.kind === 'ready' ? (
            <span
              className="text-display"
              style={{
                fontFamily: font.fontFamily,
                fontWeight: font.fontWeight,
                fontStyle: font.fontStyle,
              }}
            >
              Aa
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2 px-4 text-center text-body-sm text-on-surface-variant">
              <Icon decorative name={font.kind === 'failed' ? 'alert' : 'loading'} size="xl" />
              {font.kind === 'failed' ? '字体预览不可用' : '正在加载字体…'}
            </span>
          )
        ) : poster === undefined || failed ? (
          <Icon decorative name={isVideo(item) ? 'video' : 'file'} size="xl" />
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
          {kindName(item.kind)}
          {item.durationMs === null ? '' : ` · ${(item.durationMs / 1000).toFixed(1)} 秒`}
        </span>
      </button>
      <div className="flex flex-col gap-2 pt-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-body font-medium">{item.name}</h3>
          {item.brand === null ? null : <Tag>{item.brand}</Tag>}
        </div>
        {isVideo(item) ? (
          <p className="text-body-sm text-on-surface-variant">
            {hasVideoFacts(item)
              ? `${item.width} × ${item.height} · ${item.hasAudio ? '带原声' : '无原声'}`
              : '视频参数不完整，无法用于合成'}
          </p>
        ) : null}
        {item.disabledAt === null ? null : (
          <div>
            <Tag>已停用</Tag>
          </div>
        )}
        {canManage ? (
          <div className="flex flex-wrap gap-1">
            <Button disabled={busy} onClick={onEdit} size="md" variant="ghost">
              编辑
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

function FontPreviewDialog({ font, onClose }: { font: BrandTemplate; onClose: () => void }) {
  const [text, setText] = useState('Made for your next adventure.')
  const preview = usePreviewFont(font, text)
  const openerRef = useRef<HTMLElement | null>(null)
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          openerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          openerRef.current?.focus()
        }}
      >
        <DialogHeader title={font.name} closeLabel="关闭字体预览" />
        <DialogBody className="flex flex-col gap-4">
          <Input
            aria-label="预览文字"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            maxLength={200}
          />
          <div className="grid min-h-40 place-items-center rounded-lg bg-surface-container-low p-6">
            {preview.kind === 'ready' ? (
              <p
                className="w-full text-center text-headline wrap-anywhere whitespace-pre-line"
                style={{
                  fontFamily: preview.fontFamily,
                  fontWeight: preview.fontWeight,
                  fontStyle: preview.fontStyle,
                }}
              >
                {normalizeCaptionText(text)}
              </p>
            ) : preview.kind === 'failed' ? (
              <div className="flex flex-col items-center gap-3">
                <p role="alert" className="text-body-sm text-error">
                  {preview.message}
                </p>
                <Button size="md" variant="tonal" onClick={preview.retry}>
                  重试
                </Button>
              </div>
            ) : (
              <ListPending label="正在加载字体…" />
            )}
          </div>
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
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
  const openerRef = useRef<HTMLElement | null>(null)
  const [name, setName] = useState(editor.kind === 'edit' ? editor.template.name : '')
  const [brand, setBrand] = useState(editor.kind === 'edit' ? (editor.template.brand ?? '') : '')
  const [kind, setKind] = useState<ResourceKind>('font')
  const [media, setMedia] = useState<{ file: File; uploadId: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (name.trim() === '') {
      setError('名称不能为空，请填写名称')
      return
    }
    if (editor.kind === 'create' && media === null) {
      setError('尚未选择文件，请选择品牌资源')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const metadata = { name: name.trim(), brand: brand.trim() || null }
      if (editor.kind === 'edit') await updateBrandTemplate(editor.template.id, metadata)
      else if (media !== null) {
        const uploadId =
          media.uploadId ??
          (kind === 'font'
            ? await uploadBrandFontFile(media.file, setProgress)
            : (await uploadMediaFile(media.file, 'video', { onProgress: setProgress })).uploadId)
        // 确认失败保留已经直传的文件，重试只重新登记资源。
        setMedia({ file: media.file, uploadId })
        if (kind === 'font') await confirmBrandFont(uploadId, metadata)
        else await createBrandTemplate({ ...metadata, kind, uploadId })
      }
      toast.success(editor.kind === 'edit' ? '品牌资源已更新' : '品牌资源已创建')
      await onSaved()
    } catch (cause) {
      setError(errorMessageOf(cause, '保存品牌资源失败，请重试'))
    } finally {
      setBusy(false)
      setProgress(null)
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
        onOpenAutoFocus={() => {
          openerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          openerRef.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader
          closeLabel="关闭资源编辑"
          title={editor.kind === 'edit' ? '编辑品牌资源' : '上传品牌资源'}
        />
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
          <DialogBody className="flex flex-col gap-4">
            {editor.kind === 'edit' ? null : (
              <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-kind`}>
                类型
                <Select
                  id={`${formId}-kind`}
                  disabled={busy}
                  value={kind}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    if (value !== 'font' && value !== 'intro' && value !== 'outro') return
                    setKind(value)
                    setMedia(null)
                    setError(null)
                    if (fileRef.current !== null) fileRef.current.value = ''
                  }}
                >
                  <option value="font">字体</option>
                  <option value="intro">片头</option>
                  <option value="outro">片尾</option>
                </Select>
              </label>
            )}
            <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-name`}>
              名称
              <Input
                id={`${formId}-name`}
                disabled={busy}
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-2 text-body-sm" htmlFor={`${formId}-brand`}>
              品牌
              <Input
                id={`${formId}-brand`}
                disabled={busy}
                maxLength={100}
                value={brand}
                placeholder="可选"
                onChange={(event) => setBrand(event.currentTarget.value)}
              />
            </label>
            {editor.kind === 'edit' ? null : (
              <div className="flex flex-col gap-2 text-body-sm">
                <label htmlFor={`${formId}-file`}>资源文件</label>
                <input
                  id={`${formId}-file`}
                  ref={fileRef}
                  className="sr-only"
                  accept={kind === 'font' ? BRAND_FONT_ACCEPT : MEDIA_VIDEO_ACCEPT}
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
                    variant="tonal"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    选择文件
                  </Button>
                  <span className="min-w-0 truncate text-on-surface-variant">
                    {media?.file.name ?? (kind === 'font' ? 'TTF / OTF' : 'MP4 / MOV · 最长 10 秒')}
                  </span>
                </div>
              </div>
            )}
            {progress === null ? null : (
              <p role="status" className="text-body-sm text-on-surface-variant">
                {progress < 1 ? `正在上传 ${Math.round(progress * 100)}%` : '正在校验资源…'}
              </p>
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
              {busy ? '正在保存…' : '保存资源'}
            </Button>
          </DialogFooter>
        </form>
      </DialogSurface>
    </DialogRoot>
  )
}
