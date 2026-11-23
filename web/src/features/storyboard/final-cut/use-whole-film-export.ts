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
import type { ExportTier } from './composition/export-resolution'
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

/** 单次导出的目标版本：语言代码（`locale`，原文为 `null`）与分辨率档位（`resolution`，按画布原尺寸导出为 `null`）。 */
export type ExportVersion = Pick<WholeFilmExportOut, 'locale' | 'resolution'>

/**
 * 导出任务视图状态。提交中、进行中与完成态携带本次导出的目标版本（见 `ExportVersion`）：
 * 提交态锁定点击「导出」瞬间编辑器当前语言与激活档位，后续状态取自后端响应，不受之后切换语言或档位影响。
 */
export type ExportView =
  | { kind: 'idle' }
  | ({ kind: 'starting' } & ExportVersion)
  | ({ kind: 'queued'; ahead: number | null } & ExportVersion)
  | ({ kind: 'rendering'; progress: number | null } & ExportVersion)
  | ({ kind: 'uploading' } & ExportVersion)
  | ({ kind: 'done'; exportId: string; downloadUrl: string } & ExportVersion)
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

const isRunning = (status: WholeFilmExportOut['status']) =>
  status === 'queued' || status === 'rendering' || status === 'uploading'

const failureText = (error: WholeFilmExportOut['error']) => {
  if (error?.code === 'RENDER_REJECTED') return `成片导出失败：${error.message}`
  // 渲染服务返回的 message 为缺失字体名列表（顿号分隔）
  if (error?.code === 'font-missing')
    return `用到的字体 ${error.message} 不在可选字体里，无法导出；请换成可选字体后重新导出`
  // 渲染服务返回的 message 即面向用户的完整提示文案（见 composition/export-resolution.ts 的 tierUnsupportedText）
  if (error?.code === 'resolution-unsupported') return error.message
  return FAILURE_TEXT[error?.code ?? ''] ?? '成片导出失败，请重新导出'
}

const viewOf = (state: WholeFilmExportOut): ExportView => {
  const version: ExportVersion = { locale: state.locale, resolution: state.resolution }
  switch (state.status) {
    case 'queued':
      return { kind: 'queued', ahead: state.queuePosition, ...version }
    case 'rendering':
      return { kind: 'rendering', progress: state.progress, ...version }
    case 'uploading':
      return { kind: 'uploading', ...version }
    case 'done':
      return state.downloadUrl === null
        ? { kind: 'failed', message: '导出已完成，但未获取到下载地址；请重新导出' }
        : { kind: 'done', exportId: state.id, downloadUrl: state.downloadUrl, ...version }
    case 'failed':
      return { kind: 'failed', message: failureText(state.error) }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

/**
 * 查询本对话最近一次成片导出状态，并提供发起与取消操作。
 * 发起时传入当前展示语言与导出分辨率档位（按画布原尺寸导出传 `null`）；提交前先通过 `settle` 落盘未保存改动，落盘失败则中止发起。
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

  const start = async (locale: Language, resolution: ExportTier | null) => {
    setLocal({ kind: 'starting', locale, resolution })
    if (!(await settle())) {
      setLocal(null)
      return
    }
    try {
      await startWholeFilmExport(conversationId, locale, resolution)
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
