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

/** 失败原因（`error.code`）换成给人看的话；渲染服务自己带的 message 是给开发看的，不直接显示 */
const FAILURE_TEXT: Record<string, string> = {
  'render-failed': '整片渲染失败，请重新导出',
  'upload-failed': '整片上传失败，请重新导出',
  'media-unreachable': '有素材读不到，请稍后重新导出',
  timeout: '整片渲染超时，请重新导出',
  RENDER_LOST: '渲染服务重启过，请重新导出',
  PROVIDER_TIMEOUT: '排队太久，请重新导出',
  RENDER_UNAVAILABLE: '渲染服务连不上，请稍后重新导出',
}

export type ExportView =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'queued'; ahead: number | null }
  /** `progress` 为 null：只知道在渲染，渲染服务还答不上进度 */
  | { kind: 'rendering'; progress: number | null }
  | { kind: 'uploading' }
  /** `exportId`：这次导出的整片记录，高清版按它做；`sourceJobIds`：这次导出用到的成片，下载时各记一次下载 */
  | { kind: 'done'; exportId: string; downloadUrl: string; sourceJobIds: readonly string[] }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

const isRunning = (status: WholeFilmExportOut['status']) =>
  status === 'queued' || status === 'rendering' || status === 'uploading'

const failureText = (error: WholeFilmExportOut['error']) =>
  // 渲染服务不收这份草稿：它给的那句就是原因，同提交时被拒的说法
  error?.code === 'RENDER_REJECTED'
    ? `整片导出失败：${error.message}`
    : (FAILURE_TEXT[error?.code ?? ''] ?? '整片导出失败，请重新导出')

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
        : {
            kind: 'done',
            exportId: state.id,
            downloadUrl: state.downloadUrl,
            sourceJobIds: state.sourceJobIds,
          }
    case 'failed':
      return { kind: 'failed', message: failureText(state.error) }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

/**
 * 导出整片：显示这段对话最近一次导出，没结束就轮询到结束，所以重开编辑器接着看进度或下载；
 * 关掉编辑器不影响导出。提交时先把手上的改动存好，按存好的那一版提交。
 *
 * `settle` 存好草稿并给出服务端那一版的 revision，存不好时为 undefined（原因由草稿那边显示）。
 */
export function useWholeFilmExport(
  conversationId: string,
  settle: () => Promise<number | undefined>,
) {
  // 提交中与提交失败只在本地显示；其余时候显示最近一次导出
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
      // 草稿在提交前又被存了一版：再存一次手上的，按新的那一版重提一次
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
      // 读回新受理的这一次再撤掉「提交中」，免得先闪一下上一次导出的样子
      if (result !== undefined) await latest.refetch()
      setLocal(null)
    } catch (error) {
      setLocal({ kind: 'failed', message: errorMessageOf(error, '整片导出失败') })
    }
  }

  /** 取消不成（正在交给渲染服务、渲染服务连不上）只提示原因，进度照常轮询 */
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
