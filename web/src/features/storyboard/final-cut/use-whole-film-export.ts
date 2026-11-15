import { useQuery } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import type { WholeFilmExportOut } from '@/shared/api/generated/types.gen'
import { toast } from '@/shared/ui/toast'
import {
  cancelWholeFilmExport,
  readLatestWholeFilmExport,
  wholeFilmQueryKeys,
} from './final-cut.api'

const POLL_MS = 1_500

const FAILURE_TEXT: Record<string, string> = {
  'render-failed': '成片渲染失败，请重新导出',
  'upload-failed': '成片上传失败，请重新导出',
  'media-unreachable': '部分素材读取失败，请稍后重新导出',
  'media-mismatch':
    '有视频片段标记为有声音，但素材没有声音，无法导出；请将该视频片段设为静音后重新导出',
  timeout: '成片渲染超时，请重新导出',
  RENDER_LOST: '渲染服务已重启，请重新导出',
  PROVIDER_TIMEOUT: '导出等待超时，请重新导出',
  RENDER_UNAVAILABLE: '渲染服务无法连接，请稍后重新导出',
  FILM_CHANGED: 'final-cut 在排队期间已被修改，请重新导出',
}

export type ExportView =
  | { kind: 'idle' }
  | { kind: 'queued'; ahead: number | null }
  | { kind: 'rendering'; progress: number | null }
  | { kind: 'uploading' }
  | { kind: 'done'; exportId: string; downloadUrl: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

const isRunning = (status: WholeFilmExportOut['status']) =>
  status === 'queued' || status === 'rendering' || status === 'uploading'

const failureText = (error: WholeFilmExportOut['error']) =>
  error?.code === 'RENDER_REJECTED'
    ? `成片导出失败：${error.message}`
    : (FAILURE_TEXT[error?.code ?? ''] ?? '成片导出失败，请重新导出')

const viewOf = (state: WholeFilmExportOut): ExportView => {
  switch (state.status) {
    case 'queued':
      return { kind: 'queued', ahead: state.queuePosition }
    case 'rendering':
      return { kind: 'rendering', progress: state.progress }
    case 'uploading':
      return { kind: 'uploading' }
    case 'done':
      return state.downloadUrl === null
        ? { kind: 'failed', message: '导出已完成，但未获取到下载地址；请重新导出' }
        : { kind: 'done', exportId: state.id, downloadUrl: state.downloadUrl }
    case 'failed':
      return { kind: 'failed', message: failureText(state.error) }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

/** 这段对话最近一次导出的样子，和取消它。发起导出暂停着，这里不发起。 */
export function useWholeFilmExport(conversationId: string) {
  const latest = useQuery({
    queryKey: wholeFilmQueryKeys.latestExport(conversationId),
    queryFn: ({ signal }) => readLatestWholeFilmExport(conversationId, signal),
    refetchInterval: (query) => {
      const current = query.state.data
      return current !== undefined && current !== null && isRunning(current.status)
        ? POLL_MS
        : false
    },
    retry: false,
    gcTime: 0,
  })

  const current = latest.data ?? null
  const view: ExportView = latest.isError
    ? { kind: 'failed', message: errorMessageOf(latest.error, '读取导出进度失败') }
    : current === null
      ? { kind: 'idle' }
      : viewOf(current)

  const cancel = async () => {
    if (current === null) return
    try {
      await cancelWholeFilmExport(conversationId, current.id)
      await latest.refetch()
    } catch (error) {
      toast.error(errorMessageOf(error, '取消导出失败'))
    }
  }

  return { view, cancel }
}
