import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { BlockedReason } from '../components/blocked-reason'
import type { ExportView } from './use-whole-film-export'

type ExportControlProps = {
  view: ExportView
  /** 不能导出的原因；给了就置灰 */
  blocked: string | undefined
  onStart: () => void
  onCancel: () => void
  onDownload: () => void
}

const statusText = (view: ExportView): string | undefined => {
  switch (view.kind) {
    case 'starting':
      return '正在提交导出…'
    case 'queued':
      return view.ahead === null || view.ahead === 0
        ? '排队中，马上开始'
        : `排队中，前面还有 ${view.ahead} 个`
    case 'rendering':
      return `正在渲染 ${Math.round(view.progress * 100)}%`
    case 'uploading':
      return '正在上传成片…'
    case 'failed':
      return view.message
    case 'cancelled':
      return '已取消导出'
    case 'idle':
    case 'done':
      return undefined
  }
}

/** 顶栏的导出：提交、进度与取消、完成后下载。成片不留存，每次都按当前这一版重新渲染。 */
export function ExportControl({
  view,
  blocked,
  onStart,
  onCancel,
  onDownload,
}: ExportControlProps) {
  const running = view.kind === 'queued' || view.kind === 'rendering' || view.kind === 'uploading'
  const text = statusText(view)
  return (
    <div className="wf-export">
      {text === undefined ? null : (
        <span
          className={view.kind === 'failed' ? 'wf-export-status is-error' : 'wf-export-status'}
          role="status"
        >
          {text}
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
          <a
            className="wf-download editor-compose ui-state ui-focus"
            download
            href={view.downloadUrl}
            onClick={onDownload}
          >
            <Icon decorative name="download" size="md" />
            下载整片
          </a>
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
