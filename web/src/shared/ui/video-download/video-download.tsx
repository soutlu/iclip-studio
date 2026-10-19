import type { ReactNode } from 'react'
import { useMediaDownload } from '@/shared/api/media-download'
import { recordVideoDownloaded } from '@/shared/api/tracking'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

type VideoDownloadProps = {
  /** 每下载一次，按这些生成记录各记一条下载事件：成片是它自己，导出的整片是它用到的各条成片；为空就不记。 */
  downloadedJobIds: readonly string[]
  url: string
  watermarkUrl: string | null
  /** 叠在按钮自己的样式上，如放大尺寸。 */
  className?: string
  /** 可见文字；给了就渲染成共用的带字按钮（下载图标在前），可访问名称就是这段文字。缺省是描边小圆图标按钮。 */
  children?: ReactNode
}

/** 视频的下载按钮：只有原片时点了就下；上游也给了水印版时先选哪一份。 */
export function VideoDownload({
  children,
  className,
  downloadedJobIds,
  url,
  watermarkUrl,
}: VideoDownloadProps) {
  const { downloading, download: fetchAndSave } = useMediaDownload()

  // 下载事件与取字节并行发出，不等它回来。
  const download = (href: string, fallbackName: string) => {
    for (const jobId of downloadedJobIds) recordVideoDownloaded(jobId)
    void fetchAndSave(href, fallbackName)
  }

  const onClick = watermarkUrl === null ? () => download(url, '生成的视频') : undefined
  const trigger =
    children === undefined ? (
      <IconButton
        aria-busy={downloading}
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
  if (watermarkUrl === null) return trigger
  return (
    <MenuRoot>
      {/* disabled 交给菜单触发器：它拦下自己的按下与按键，再转交给按钮。 */}
      <MenuTrigger asChild disabled={downloading}>
        {trigger}
      </MenuTrigger>
      <MenuSurface align="end">
        <MenuItem onSelect={() => download(url, '生成的视频')}>下载原片</MenuItem>
        <MenuItem onSelect={() => download(watermarkUrl, '生成的视频（水印版）')}>
          下载水印版
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}
