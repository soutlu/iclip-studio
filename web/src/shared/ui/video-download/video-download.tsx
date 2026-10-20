import { useId, type ReactNode } from 'react'
import { useMediaDownload } from '@/shared/api/media-download'
import { recordVideoDownloaded } from '@/shared/api/tracking'
import {
  enhanceBadge,
  enhanceNoticeId,
  useEnhanceTiers,
  useSubmitVideoEnhancement,
  type EnhanceResolution,
  type EnhanceTierRow,
} from '@/shared/api/video-enhancements'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { useElapsed } from '@/shared/ui/media-preview'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'

type VideoDownloadProps = {
  /** 每下载一次，按这些生成记录各记一条下载事件：成片是它自己，导出的整片是它用到的各条成片；为空就不记。下载高清版同样按它记。 */
  downloadedJobIds: readonly string[]
  url: string
  watermarkUrl: string | null
  /** 叠在按钮自己的样式上，如放大尺寸。 */
  className?: string
  /** 可见文字；给了就渲染成共用的带字按钮（下载图标在前），可访问名称就是这段文字。缺省是描边小圆图标按钮。 */
  children?: ReactNode
  /** 能做高清版的那条记录（成片或导出的整片）；给了就读它各档的高清版，菜单里多出高清项。不给就和没有高清版时一样。 */
  enhanceSourceId?: string
  /** 只有原片时菜单第一项的名字，整片传「下载整片」。 */
  originalLabel?: string
  /** 图标按钮右上角的高清版状态点：有在做的为绿，最近一次没做成为红。带字按钮不画点。 */
  showEnhanceDot?: boolean
  /** 片长，用来估高清版要多久；不知道就不估。 */
  durationMs?: number | null | undefined
}

/** 上游处理耗时约为片长的 15–20 倍，按慢的估。 */
const ENHANCE_SLOWDOWN = 20

const estimateText = (durationMs: number | null | undefined): string | undefined =>
  durationMs === null || durationMs === undefined
    ? undefined
    : `约 ${Math.ceil(((durationMs / 1000) * ENHANCE_SLOWDOWN) / 60)} 分钟`

const DOT_LABEL = { failed: '高清版生成失败', running: '高清版正在生成' } as const

const FALLBACK_NAME = '生成的视频'

/**
 * 视频的下载按钮：只有原片且没有高清档时点了就下；否则先开菜单，选原片、水印版或各档高清版。
 * 高清版一档一行：还没做的点了就提交，菜单不关，那一行原地变成「正在生成」；做好的直接下载。
 */
export function VideoDownload({
  children,
  className,
  downloadedJobIds,
  durationMs,
  enhanceSourceId,
  originalLabel = '下载原片',
  showEnhanceDot = true,
  url,
  watermarkUrl,
}: VideoDownloadProps) {
  const { downloading, download: fetchAndSave } = useMediaDownload()
  const rows = useEnhanceTiers(enhanceSourceId)
  const submit = useSubmitVideoEnhancement()
  const descriptionId = useId()

  // 下载事件与取字节并行发出，不等它回来。
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
  const badge = showEnhanceDot && children === undefined ? enhanceBadge(rows) : null
  const trigger =
    children === undefined ? (
      <IconButton
        aria-busy={downloading}
        aria-describedby={badge === null ? undefined : descriptionId}
        badge={
          badge === null ? undefined : (
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute top-0 right-0 size-2 rounded-full ring-[1.5px] ring-surface-container-lowest',
                badge === 'running' ? 'bg-primary' : 'bg-error',
              )}
            />
          )
        }
        className={cn(
          'shrink-0 border-[0.5px] border-hairline text-on-surface aria-disabled:cursor-wait aria-disabled:opacity-60',
          downloading && '[&_svg]:animate-spin',
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
        {DOT_LABEL[badge]}
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
      <MenuRoot>
        {/* disabled 交给菜单触发器：它拦下自己的按下与按键，再转交给按钮。 */}
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

/** 高清版的一档。提交与重试时拦下菜单项的默认收起，菜单开着、那一行原地变成「正在生成」。 */
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

/** 在做的一档：转圈加已用时长，点不了。 */
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
