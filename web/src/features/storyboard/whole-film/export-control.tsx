import { useMediaDownload } from '@/shared/api/media-download'
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
      return view.progress === null ? '正在渲染…' : `正在渲染 ${Math.round(view.progress * 100)}%`
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

/**
 * 顶栏的导出：提交、进度与取消、完成后下载。每次导出都按当时存好的那一版重新渲染；
 * 成片长期留着，显示的是这段对话最近一次导出。
 */
export function ExportControl({
  view,
  blocked,
  onStart,
  onCancel,
  onDownload,
}: ExportControlProps) {
  // 成片在对象存储的公开地址上，跨域：取回字节再交给浏览器保存
  const { downloading, download } = useMediaDownload()
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
          <Button
            aria-busy={downloading}
            className="editor-compose"
            leadingIcon="download"
            loading={downloading}
            onClick={() => {
              onDownload()
              void download(view.downloadUrl, '整片.mp4')
            }}
            size="md"
          >
            下载整片
          </Button>
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
