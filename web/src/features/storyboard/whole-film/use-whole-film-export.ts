import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { WholeFilmExportOut } from '@/shared/api/generated/types.gen'
import { toast } from '@/shared/ui/toast'
import {
  cancelWholeFilmExport,
  readLatestWholeFilmExport,
  startWholeFilmExport,
  wholeFilmQueryKeys,
} from './whole-film.api'

const POLL_MS = 1_500

const FAILURE_TEXT: Record<string, string> = {
  'render-failed': '成片渲染失败，请重新导出',
  'upload-failed': '成片上传失败，请重新导出',
  'media-unreachable': '有素材读不到，请稍后重新导出',
  timeout: '成片渲染超时，请重新导出',
  RENDER_LOST: '渲染服务重启过，请重新导出',
  PROVIDER_TIMEOUT: '排队太久，请重新导出',
  RENDER_UNAVAILABLE: '渲染服务连不上，请稍后重新导出',
}

export type ExportView =
  | { kind: 'idle' }
  | { kind: 'starting' }
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
        ? { kind: 'failed', message: '导出完成了却没拿到下载地址，请重新导出' }
        : { kind: 'done', exportId: state.id, downloadUrl: state.downloadUrl }
    case 'failed':
      return { kind: 'failed', message: failureText(state.error) }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

export function useWholeFilmExport(
  conversationId: string,
  settle: () => Promise<number | undefined>,
) {
  const [local, setLocal] = useState<ExportView | null>(null)

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
  const view: ExportView =
    local ??
    (latest.isError
      ? { kind: 'failed', message: errorMessageOf(latest.error, '读取导出进度失败') }
      : current === null
        ? { kind: 'idle' }
        : viewOf(current))

  const submit = async (revision: number) => {
    try {
      return await startWholeFilmExport(conversationId, revision)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error
      const revised = await settle()
      if (revised === undefined) return undefined
      return startWholeFilmExport(conversationId, revised)
    }
  }

  const start = async () => {
    setLocal({ kind: 'starting' })
    const revision = await settle()
    if (revision === undefined) {
      setLocal(null)
      return
    }
    try {
      const result = await submit(revision)
      if (result !== undefined) await latest.refetch()
      setLocal(null)
    } catch (error) {
      setLocal({ kind: 'failed', message: errorMessageOf(error, '成片导出失败') })
    }
  }

  const cancel = async () => {
    if (current === null) return
    try {
      await cancelWholeFilmExport(conversationId, current.id)
      await latest.refetch()
    } catch (error) {
      toast.error(errorMessageOf(error, '取消导出失败'))
    }
  }

  return { view, start, cancel }
}
