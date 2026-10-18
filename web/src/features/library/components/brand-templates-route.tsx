import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import {
  brandTemplateQueryKeys,
  updateBrandTemplate,
  useBrandTemplates,
  type BrandTemplate,
} from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import { Select } from '@/shared/ui/field'
import { ListEmpty, ListError, ListPending } from '@/shared/ui/list-state'
import { toast } from '@/shared/ui/toast'
import type { BrandTemplateScope } from '../brand-templates'
import { BrandFontPreviewDialog } from './brand-font-preview-dialog'
import { BrandTemplateCard } from './brand-template-card'
import { BrandTemplateEditor, type BrandTemplateEditing } from './brand-template-editor'
import { LibraryPageHeader } from './library-page-header'

type Props = {
  tabs: ReactNode
  canManage: boolean
  canUpload: boolean
  scope: BrandTemplateScope
  onScopeChange: (scope: BrandTemplateScope) => void
}

const includes = (text: string, search: string) =>
  text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())

export function BrandTemplatesRoute({ tabs, canManage, canUpload, scope, onScopeChange }: Props) {
  const queryClient = useQueryClient()
  const { brand, includeDisabled, q: search } = scope
  const [editing, setEditing] = useState<BrandTemplateEditing | null>(null)
  const [fontPreview, setFontPreview] = useState<BrandTemplate | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = useBrandTemplates({ includeDisabled: canManage && includeDisabled })
  const fonts =
    query.data?.items.filter(
      (item) => (brand === undefined || item.brand === brand) && includes(item.name, search),
    ) ?? []
  const brands = [
    ...new Set([
      ...(query.data?.items.flatMap((item) => (item.brand === null ? [] : [item.brand])) ?? []),
      ...(brand === undefined ? [] : [brand]),
    ]),
  ].sort((left, right) => left.localeCompare(right))
  const filtered = search.trim() !== '' || brand !== undefined
  const refresh = () => queryClient.invalidateQueries({ queryKey: brandTemplateQueryKeys.all })
  const toggle = async (template: BrandTemplate) => {
    if (!canManage || updating !== null) return
    setUpdating(template.id)
    setError(null)
    try {
      const disabled = template.disabledAt === null
      await updateBrandTemplate(template.id, { disabled })
      await refresh()
      toast.success(disabled ? '字体已停用' : '字体已恢复使用')
    } catch (cause) {
      setError(errorMessageOf(cause, '更新字体失败，请重试'))
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
            label: '搜索字体',
            placeholder: '搜索名称…',
            value: search,
            onSearch: (q) => onScopeChange({ ...scope, q }),
          }}
          action={
            canManage && canUpload ? (
              <Button leadingIcon="upload" onClick={() => setEditing({ kind: 'create' })}>
                上传字体
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-3 py-4">
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
              显示已停用字体
            </label>
          ) : null}
        </div>
        <section aria-labelledby="brand-fonts-heading" className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="brand-fonts-heading" className="text-title font-semibold text-on-surface">
              字体
            </h2>
            {query.data === undefined ? null : (
              <span className="text-body-sm text-on-surface-faint">共 {fonts.length} 个字体</span>
            )}
          </div>
          {error === null ? null : (
            <p className="text-body-sm text-error" role="alert">
              {error}
            </p>
          )}
          {query.isPending ? (
            <ListPending label="正在读取字体…" />
          ) : query.isError ? (
            <ListError
              message={errorMessageOf(query.error, '读取字体失败')}
              onRetry={() => void query.refetch()}
            />
          ) : fonts.length === 0 ? (
            <ListEmpty>
              {filtered ? '暂无匹配字体，请调整筛选条件' : '暂无字体，请联系管理员上传'}
            </ListEmpty>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
              {fonts.map((item) => (
                <BrandTemplateCard
                  key={item.id}
                  item={item}
                  canManage={canManage}
                  busy={updating !== null}
                  onPreview={() => setFontPreview(item)}
                  onEdit={() => setEditing({ kind: 'edit', template: item })}
                  onToggle={() => void toggle(item)}
                />
              ))}
            </div>
          )}
        </section>
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
