import type { BrandTemplate } from '@/shared/api/brand-templates'
import { Icon } from '@/shared/icons'
import { usePreviewFont } from '@/shared/lib/use-preview-font'
import { Button } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'

type Props = {
  item: BrandTemplate
  canManage: boolean
  busy: boolean
  onPreview: () => void
  onEdit: () => void
  onToggle: () => void
}

export function BrandTemplateCard({ item, canManage, busy, onPreview, onEdit, onToggle }: Props) {
  return (
    <article aria-label={item.name} className="flex min-w-0 flex-col">
      <button
        className="relative grid aspect-video ui-state cursor-pointer place-items-center overflow-hidden rounded-md bg-surface-container-low ui-focus"
        aria-label={`预览字体：${item.name}`}
        onClick={onPreview}
        type="button"
      >
        <FontSample font={item} />
        <span className="library-card-badge absolute bottom-2 left-2">字体</span>
      </button>
      <div className="flex flex-col gap-2 pt-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-body font-medium">{item.name}</h3>
          {item.brand === null ? null : <Tag>{item.brand}</Tag>}
        </div>
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

function FontSample({ font }: { font: BrandTemplate }) {
  const preview = usePreviewFont(font, 'Aa')
  if (preview.kind === 'ready')
    return (
      <span
        className="text-display"
        style={{
          fontFamily: preview.fontFamily,
          fontWeight: preview.fontWeight,
          fontStyle: preview.fontStyle,
        }}
      >
        Aa
      </span>
    )
  const failed = preview.kind === 'failed' || preview.kind === 'unsupported'
  return (
    <span className="flex flex-col items-center gap-2 px-4 text-center text-body-sm text-on-surface-variant">
      <Icon decorative name={failed ? 'alert' : 'loading'} size="xl" />
      {failed ? '字体预览不可用' : '正在加载字体…'}
    </span>
  )
}
