import { useEnhanceTiers, type EnhanceTierRow } from '@/shared/api/video-enhancements'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { VideoDownload } from '@/shared/ui/video-download'
import { BlockedReason } from '../components/blocked-reason'
import type { ExportView } from './use-whole-film-export'

type ExportControlProps = {
  view: ExportView
  blocked: string | undefined
  onStart: () => void
  onCancel: () => void
}

type Status = { text: string; tone: 'normal' | 'busy' | 'error' }

const exportStatus = (view: ExportView): Status | undefined => {
  switch (view.kind) {
    case 'starting':
      return { text: '正在提交导出…', tone: 'normal' }
    case 'queued':
      return {
        text:
          view.ahead === null || view.ahead === 0
            ? '排队中，马上开始'
            : `排队中，前面还有 ${view.ahead} 个`,
        tone: 'normal',
      }
    case 'rendering':
      return {
        text: view.progress === null ? '正在渲染…' : `正在渲染 ${Math.round(view.progress * 100)}%`,
        tone: 'normal',
      }
    case 'uploading':
      return { text: '正在上传成片…', tone: 'normal' }
    case 'failed':
      return { text: view.message, tone: 'error' }
    case 'cancelled':
      return { text: '已取消导出', tone: 'normal' }
    case 'idle':
    case 'done':
      return undefined
  }
}

const enhanceStatus = (rows: readonly EnhanceTierRow[]): Status | undefined => {
  const running = rows.find((row) => row.state === 'running')
  if (running !== undefined) return { text: `正在生成高清版 ${running.resolution}`, tone: 'busy' }
  const failed = rows.find((row) => row.state === 'failed')
  if (failed !== undefined)
    return { text: `高清版 ${failed.resolution} 生成失败，请重试`, tone: 'error' }
  return undefined
}

export function ExportControl({ view, blocked, onStart, onCancel }: ExportControlProps) {
  const running = view.kind === 'queued' || view.kind === 'rendering' || view.kind === 'uploading'
  const rows = useEnhanceTiers(view.kind === 'done' ? view.exportId : undefined)
  const status = exportStatus(view) ?? enhanceStatus(rows)
  return (
    <div className="wf-export">
      {status === undefined ? null : (
        <span
          className={status.tone === 'error' ? 'wf-export-status is-error' : 'wf-export-status'}
          role="status"
        >
          {status.tone === 'busy' ? (
            <Icon className="animate-spin" decorative name="spinner" size="xs" />
          ) : null}
          {status.text}
        </span>
      )}
      {running ? (
        <Button onClick={onCancel} size="md" variant="outlined">
          取消导出
        </Button>
      ) : view.kind === 'done' ? (
        <>
          <Button onClick={onStart} size="md" variant="ghost">
            重新导出
          </Button>
          <VideoDownload
            className="editor-compose"
            downloadedJobIds={view.sourceJobIds}
            enhanceSourceId={view.exportId}
            originalLabel="下载成片"
            url={view.downloadUrl}
            watermarkUrl={null}
          >
            下载成片
          </VideoDownload>
        </>
      ) : (
        <BlockedReason reason={blocked} side="bottom">
          <Button
            aria-disabled={blocked === undefined && view.kind !== 'starting' ? undefined : true}
            className="editor-compose"
            leadingIcon="download"
            loading={view.kind === 'starting'}
            onClick={() => {
              if (blocked === undefined && view.kind !== 'starting') onStart()
            }}
            size="md"
          >
            导出
          </Button>
        </BlockedReason>
      )}
    </div>
  )
}
