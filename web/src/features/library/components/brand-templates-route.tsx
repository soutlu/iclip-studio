import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import {
  brandTemplateQueryKeys,
  updateBrandTemplate,
  useBrandTemplates,
  type BrandTemplate,
} from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Select } from '@/shared/ui/field'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import {
  BRAND_TEMPLATE_KINDS,
  brandTemplateKindOf,
  type BrandTemplateScope,
} from '../brand-templates'
import { BrandFontPreviewDialog } from './brand-font-preview-dialog'
import { BRAND_VIDEO_SNAPSHOT_AT, BrandTemplateCard } from './brand-template-card'
import { BrandTemplateEditor, type BrandTemplateEditing } from './brand-template-editor'
import { LibraryPageHeader } from './library-page-header'

type Props = {
  tabs: ReactNode
  canManage: boolean
  canUpload: boolean
  scope: BrandTemplateScope
  onScopeChange: (scope: BrandTemplateScope) => void
}

export function BrandTemplatesRoute({ tabs, canManage, canUpload, scope, onScopeChange }: Props) {
  const queryClient = useQueryClient()
  const { kind, brand, includeDisabled, q: search } = scope
  const [editing, setEditing] = useState<BrandTemplateEditing | null>(null)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const [fontPreview, setFontPreview] = useState<BrandTemplate | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  const openPreview = (item: BrandTemplate) => {
    const media = brandTemplateKindOf(item.kind)?.media
    if (media === 'font') setFontPreview(item)
    else if (media === 'video')
      setPreview({
        kind: 'video',
        name: item.name,
        url: item.url,
        poster: videoSnapshotUrl(item.url, 720, BRAND_VIDEO_SNAPSHOT_AT),
      })
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
              <Button leadingIcon="upload" onClick={() => setEditing({ kind: 'create' })}>
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
              onScopeChange({ ...scope, kind: brandTemplateKindOf(value)?.value })
            }
          >
            <FilterChip value="all">全部</FilterChip>
            {BRAND_TEMPLATE_KINDS.map((option) => (
              <FilterChip key={option.value} value={option.value}>
                {option.label}
              </FilterChip>
            ))}
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
              <BrandTemplateCard
                key={item.id}
                item={item}
                canManage={canManage}
                busy={updating !== null}
                onPreview={() => openPreview(item)}
                onEdit={() => setEditing({ kind: 'edit', template: item })}
                onToggle={() => void toggle(item)}
              />
            ))}
          </div>
        )}
      </div>
      {editing === null || !canManage ? null : (
        <BrandTemplateEditor
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh()
            setEditing(null)
          }}
        />
      )}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
      {fontPreview === null ? null : (
        <BrandFontPreviewDialog
          key={fontPreview.id}
          font={fontPreview}
          onClose={() => setFontPreview(null)}
        />
      )}
    </main>
  )
}
