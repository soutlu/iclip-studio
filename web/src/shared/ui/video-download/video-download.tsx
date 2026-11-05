import { useQueryClient } from '@tanstack/react-query'
import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { useMediaDownload } from '@/shared/api/media-download'
import { recordVideoDownloaded } from '@/shared/api/tracking'
import {
  enhanceBadge,
  enhanceNoticeId,
  settledOwnJobIds,
  useEnhanceTiers,
  useSubmitVideoEnhancement,
  videoEnhancementsKeys,
  type EnhanceBadge,
  type EnhanceResolution,
  type EnhanceTierRow,
} from '@/shared/api/video-enhancements'
import { markEnhancementsSeen, useSeenEnhancements } from '@/shared/api/video-enhancements-seen'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { useElapsed } from '@/shared/ui/media-preview'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'

type VideoDownloadProps = {
  downloadedJobIds: readonly string[]
  url: string
  watermarkUrl: string | null
  className?: string
  children?: ReactNode
  enhanceSourceId?: string
  originalLabel?: string
  durationMs?: number | null | undefined
}

const ENHANCE_SLOWDOWN = 20

const estimateText = (durationMs: number | null | undefined): string | undefined =>
  durationMs === null || durationMs === undefined
    ? undefined
    : `约 ${Math.ceil(((durationMs / 1000) * ENHANCE_SLOWDOWN) / 60)} 分钟`

const BADGE_LABEL: Record<EnhanceBadge, string> = {
  done: '高清版已生成',
  failed: '高清版生成失败',
  running: '高清版正在生成',
}

const FALLBACK_NAME = '生成的视频'

function EnhanceBadgeMark({ badge }: { badge: EnhanceBadge }) {
  if (badge === 'running') {
    return <span aria-hidden className="video-download-ring" data-enhance-ring="" />
  }
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-0 right-0 size-2 rounded-full ring-[1.5px] ring-surface-container-lowest',
        badge === 'done' ? 'bg-primary' : 'bg-error',
      )}
      data-enhance-dot={badge}
    />
  )
}

export function VideoDownload({
  children,
  className,
  downloadedJobIds,
  durationMs,
  enhanceSourceId,
  originalLabel = '下载原片',
  url,
  watermarkUrl,
}: VideoDownloadProps) {
  const { downloading, download: fetchAndSave } = useMediaDownload()
  const rows = useEnhanceTiers(enhanceSourceId)
  const submit = useSubmitVideoEnhancement()
  const queryClient = useQueryClient()
  const seen = useSeenEnhancements()
  const [menuOpen, setMenuOpen] = useState(false)
  const descriptionId = useId()
  const settledIds = settledOwnJobIds(rows)
  const settledKey = settledIds.join(',')

  useLayoutEffect(() => {
    if (menuOpen && settledKey !== '') markEnhancementsSeen(settledKey.split(','))
  }, [menuOpen, settledKey])

  const onMenuOpenChange = (open: boolean) => {
    setMenuOpen(open)
    if (!open || enhanceSourceId === undefined) return
    markEnhancementsSeen(settledIds)
    void queryClient.invalidateQueries({ queryKey: videoEnhancementsKeys.source(enhanceSourceId) })
  }

  const download = (href: string, fallbackName: string) => {
    for (const jobId of downloadedJobIds) recordVideoDownloaded(jobId)
    void fetchAndSave(href, fallbackName)
  }

  const submitTier = (resolution: EnhanceResolution) => {
    if (enhanceSourceId !== undefined) submit.mutate({ resolution, sourceJobId: enhanceSourceId })
  }

  const downloadTier = (resolution: EnhanceResolution, href: string) => {
    if (enhanceSourceId !== undefined) toast.dismiss(enhanceNoticeId(enhanceSourceId, resolution))
    download(href, `${FALLBACK_NAME}（高清版 ${resolution}）`)
  }

  const direct = watermarkUrl === null && rows.length === 0
  const onClick = direct ? () => download(url, FALLBACK_NAME) : undefined
  const badge = children === undefined ? enhanceBadge(rows, seen) : null
  const trigger =
    children === undefined ? (
      <IconButton
        aria-busy={downloading}
        aria-describedby={badge === null ? undefined : descriptionId}
        badge={badge === null ? undefined : <EnhanceBadgeMark badge={badge} />}
        className={cn(
          'shrink-0 border-[0.5px] border-hairline text-on-surface aria-disabled:cursor-wait aria-disabled:opacity-60',
          downloading && '[&>svg]:animate-spin',
          className,
        )}
        disabled={downloading}
        label={downloading ? '正在准备下载…' : '下载视频'}
        name={downloading ? 'loading' : 'download'}
        onClick={onClick}
        size="sm"
      />
    ) : (
      <Button
        aria-busy={downloading}
        className={className}
        leadingIcon="download"
        loading={downloading}
        onClick={onClick}
        size="md"
      >
        {children}
      </Button>
    )
  const description =
    badge === null ? null : (
      <span hidden id={descriptionId}>
        {BADGE_LABEL[badge]}
      </span>
    )
  if (direct) {
    return (
      <>
        {trigger}
        {description}
      </>
    )
  }
  return (
    <>
      <MenuRoot onOpenChange={onMenuOpenChange}>
        <MenuTrigger asChild disabled={downloading}>
          {trigger}
        </MenuTrigger>
        <MenuSurface align="end">
          <MenuItem onSelect={() => download(url, FALLBACK_NAME)}>
            {watermarkUrl === null ? originalLabel : '下载原片'}
          </MenuItem>
          {watermarkUrl === null ? null : (
            <MenuItem onSelect={() => download(watermarkUrl, `${FALLBACK_NAME}（水印版）`)}>
              下载水印版
            </MenuItem>
          )}
          {rows.length === 0 ? null : <MenuSeparator />}
          {rows.map((row) => (
            <EnhanceTierItem
              estimate={estimateText(durationMs)}
              key={row.resolution}
              onDownload={downloadTier}
              onSubmit={submitTier}
              row={row}
            />
          ))}
        </MenuSurface>
      </MenuRoot>
      {description}
    </>
  )
}

type EnhanceTierItemProps = {
  row: EnhanceTierRow
  estimate: string | undefined
  onSubmit: (resolution: EnhanceResolution) => void
  onDownload: (resolution: EnhanceResolution, url: string) => void
}

function EnhanceTierItem({ estimate, onDownload, onSubmit, row }: EnhanceTierItemProps) {
  const { resolution } = row
  switch (row.state) {
    case 'none':
      return (
        <MenuItem
          onSelect={(event) => {
            event.preventDefault()
            onSubmit(resolution)
          }}
          trailing={estimate}
        >
          生成高清版 {resolution}
        </MenuItem>
      )
    case 'running':
      return <RunningTierItem resolution={resolution} since={row.since} />
    case 'done':
      return (
        <MenuItem onSelect={() => onDownload(resolution, row.url)}>
          下载高清版 {resolution}
        </MenuItem>
      )
    case 'failed':
      return (
        <MenuItem
          onSelect={(event) => {
            event.preventDefault()
            onSubmit(resolution)
          }}
          trailing={<Icon decorative name="refresh" size="sm" />}
        >
          高清版 {resolution} 生成失败，请重试
        </MenuItem>
      )
  }
}

function RunningTierItem({ resolution, since }: { resolution: EnhanceResolution; since: string }) {
  const elapsed = useElapsed(since)
  return (
    <MenuItem
      className="aria-disabled:cursor-default aria-disabled:text-on-surface-variant [&>svg]:animate-spin"
      disabled
      icon="spinner"
      trailing={elapsed}
    >
      正在生成高清版 {resolution}
    </MenuItem>
  )
}
