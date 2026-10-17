import { useState } from 'react'
import type { BrandTemplate } from '@/shared/api/brand-templates'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { usePreviewFont } from '@/shared/lib/use-preview-font'
import { Button } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import { brandTemplateKindOf } from '../brand-templates'

// 片头片尾的首帧常是淡入底色，与编辑器模板列表一样取 0.5 秒处的画面。
export const BRAND_VIDEO_SNAPSHOT_AT = 0.5

const hasVideoFacts = (item: BrandTemplate) =>
  item.width !== null && item.height !== null && item.durationMs !== null && item.hasAudio !== null

type Props = {
  item: BrandTemplate
  canManage: boolean
  busy: boolean
  onPreview: () => void
  onEdit: () => void
  onToggle: () => void
}

export function BrandTemplateCard({ item, canManage, busy, onPreview, onEdit, onToggle }: Props) {
  const kind = brandTemplateKindOf(item.kind)
  return (
    <article aria-label={item.name} className="flex min-w-0 flex-col">
      <button
        className="relative grid aspect-video ui-state cursor-pointer place-items-center overflow-hidden rounded-md bg-surface-container-low ui-focus"
        aria-label={`预览资源：${item.name}`}
        onClick={onPreview}
        disabled={kind === undefined}
        type="button"
      >
        {kind?.media === 'font' ? (
          <FontSample font={item} />
        ) : kind?.media === 'video' ? (
          <VideoPoster url={item.url} />
        ) : (
          <Icon decorative name="file" size="xl" />
        )}
        <span className="library-card-badge absolute bottom-2 left-2">
          {kind?.label ?? '资源'}
          {item.durationMs === null ? '' : ` · ${(item.durationMs / 1000).toFixed(1)} 秒`}
        </span>
      </button>
      <div className="flex flex-col gap-2 pt-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-body font-medium">{item.name}</h3>
          {item.brand === null ? null : <Tag>{item.brand}</Tag>}
        </div>
        {kind?.media === 'video' ? (
          <p className="text-body-sm text-on-surface-variant">
            {hasVideoFacts(item)
              ? `${item.width} × ${item.height} · ${item.hasAudio ? '带原声' : '无原声'}`
              : '视频参数不完整，无法用于合成；请重新上传该资源'}
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

function VideoPoster({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  const poster = videoSnapshotUrl(url, 480, BRAND_VIDEO_SNAPSHOT_AT)
  if (poster === undefined || failed) return <Icon decorative name="video" size="xl" />
  return (
    <img
      alt=""
      src={poster}
      className="size-full object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
