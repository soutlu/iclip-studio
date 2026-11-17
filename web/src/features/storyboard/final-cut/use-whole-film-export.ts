import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { WholeFilmExportOut } from '@/shared/api/generated/types.gen'
import { toast } from '@/shared/ui/toast'
import {
  cancelWholeFilmExport,
  readLatestWholeFilmExport,
  startWholeFilmExport,
  wholeFilmQueryKeys,
} from './final-cut.api'
import type { Language } from './locales'

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
  'lint-failed': 'final-cut 未通过导出前检查，无法导出',
}

/** 一次导出的是哪种语言的版本，原文是 null。 */
export type ExportLocale = WholeFilmExportOut['locale']

/**
 * 导出现在的样子。提交中、进行中和完成的带着这次导出的语言（`locale`）：提交中的是点「导出」那一刻编辑器显示的
 * 语言，之后的取接口答的，导出后切了语言也不变。
 */
export type ExportView =
  | { kind: 'idle' }
  | { kind: 'starting'; locale: ExportLocale }
  | { kind: 'queued'; ahead: number | null; locale: ExportLocale }
  | { kind: 'rendering'; progress: number | null; locale: ExportLocale }
  | { kind: 'uploading'; locale: ExportLocale }
  | { kind: 'done'; exportId: string; downloadUrl: string; locale: ExportLocale }
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
      return { kind: 'queued', ahead: state.queuePosition, locale: state.locale }
    case 'rendering':
      return { kind: 'rendering', progress: state.progress, locale: state.locale }
    case 'uploading':
      return { kind: 'uploading', locale: state.locale }
    case 'done':
      return state.downloadUrl === null
        ? { kind: 'failed', message: '导出已完成，但未获取到下载地址；请重新导出' }
        : {
            kind: 'done',
            exportId: state.id,
            downloadUrl: state.downloadUrl,
            locale: state.locale,
          }
    case 'failed':
      return { kind: 'failed', message: failureText(state.error) }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

/**
 * 这段对话最近一次导出的样子，发起和取消导出。发起时给出导出哪种语言（编辑器当前显示的）；发起前先等 `settle`
 * 把没存的改动存完，它答 false（没存成）就不发起。
 */
export function useWholeFilmExport(conversationId: string, settle: () => Promise<boolean>) {
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

  const start = async (locale: Language) => {
    setLocal({ kind: 'starting', locale })
    if (!(await settle())) {
      setLocal(null)
      return
    }
    try {
      await startWholeFilmExport(conversationId, locale)
      await latest.refetch()
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
