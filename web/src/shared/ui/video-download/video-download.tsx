import type { ReactNode } from 'react'
import { useMediaDownload } from '@/shared/api/media-download'
import { recordVideoDownloaded } from '@/shared/api/tracking'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type VideoDownloadProps = {
  /** url 与 watermarkUrl 所属的生成记录；点下载即以它为主语记一条下载事件。 */
  jobId: string
  url: string
  watermarkUrl: string | null
  /** 叠在默认的描边小圆按钮上，如放大尺寸；给了 `children` 时是这个按钮的全部样式。 */
  className?: string
  /** 图标后面的可见文字；给了就渲染成带字按钮，样式全由 `className` 定，可访问名称照旧。 */
  children?: ReactNode
  /** 带字按钮名字提示的受控开合；缺省悬停、聚焦就开，用它在文字露着时不重复提示。默认图标按钮的提示由 IconButton 自带。 */
  tooltip?: { open: boolean; onOpenChange: (open: boolean) => void } | undefined
}

/** 生成视频的下载按钮：只有原片时点了就下；上游也给了水印版时先选哪一份。 */
export function VideoDownload({
  children,
  className,
  jobId,
  tooltip,
  url,
  watermarkUrl,
}: VideoDownloadProps) {
  const { downloading, download: fetchAndSave } = useMediaDownload()
  const label = downloading ? '正在准备下载…' : '下载视频'

  // 下载事件与取字节并行发出，不等它回来。
  const download = (href: string, fallbackName: string) => {
    recordVideoDownloaded(jobId)
    void fetchAndSave(href, fallbackName)
  }

  const onClick = watermarkUrl === null ? () => download(url, '生成的视频') : undefined
  const icon = downloading ? 'loading' : 'download'
  const iconOnly = children === undefined
  const trigger = iconOnly ? (
    <IconButton
      aria-busy={downloading}
      className={cn(
        'shrink-0 border-[0.5px] border-hairline text-on-surface aria-disabled:cursor-wait aria-disabled:opacity-60',
        downloading && '[&_svg]:animate-spin',
        className,
      )}
      disabled={downloading}
      label={label}
      name={icon}
      onClick={onClick}
      size="sm"
    />
  ) : (
    <button
      aria-busy={downloading}
      aria-label={label}
      className={cn(className, downloading && 'cursor-wait [&_svg]:animate-spin')}
      disabled={downloading}
      onClick={onClick}
      type="button"
    >
      <Icon decorative name={icon} size="sm" />
      {children}
    </button>
  )
  // 图标按钮自带同样的提示，只给带字按钮补上，免得两层提示叠在一起。
  const withTooltip = (node: ReactNode) =>
    iconOnly ? (
      node
    ) : (
      <DownloadTooltip label={label} tooltip={tooltip}>
        {node}
      </DownloadTooltip>
    )
  if (watermarkUrl === null) return withTooltip(trigger)
  return (
    <MenuRoot>
      {withTooltip(
        // disabled 交给菜单触发器：它拦下自己的按下与按键，再转交给按钮。
        <MenuTrigger asChild disabled={downloading}>
          {trigger}
        </MenuTrigger>,
      )}
      <MenuSurface align="end">
        <MenuItem onSelect={() => download(url, '生成的视频')}>下载原片</MenuItem>
        <MenuItem onSelect={() => download(watermarkUrl, '生成的视频（水印版）')}>
          下载水印版
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

function DownloadTooltip({
  children,
  label,
  tooltip,
}: Pick<VideoDownloadProps, 'tooltip'> & { children: ReactNode; label: string }) {
  return (
    <TooltipRoot {...tooltip}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  )
}
