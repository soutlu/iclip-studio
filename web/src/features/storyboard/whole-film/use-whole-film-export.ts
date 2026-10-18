import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { WholeFilmExportOut } from '@/shared/api/generated/types.gen'
import { recordVideoDownloaded } from '@/shared/api/tracking'
import { cancelWholeFilmExport, readWholeFilmExport, startWholeFilmExport } from './whole-film.api'

const POLL_MS = 1_500

/** 渲染服务报的失败原因（`error.code`）换成给人看的话；它带的 message 是给开发看的，不直接显示 */
const FAILURE_TEXT: Record<string, string> = {
  'render-failed': '整片渲染失败，请重新导出',
  'upload-failed': '整片上传失败，请重新导出',
  'media-unreachable': '有素材读不到，请稍后重新导出',
  timeout: '整片渲染超时，请重新导出',
}

export type ExportView =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'queued'; ahead: number | null }
  | { kind: 'rendering'; progress: number }
  | { kind: 'uploading' }
  | { kind: 'done'; downloadUrl: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

type Started = { exportId: string; sourceJobIds: string[] }

/** 编辑器关掉时取消导出：界面已经不在，取消失败只记一条警告 */
const cancelOnClose = (conversationId: string, exportId: string) => {
  cancelWholeFilmExport(conversationId, exportId).catch((error: unknown) => {
    console.warn('关闭编辑器时取消整片导出失败', { error, exportId })
  })
}

const isRunning = (status: WholeFilmExportOut['status']) =>
  status === 'queued' || status === 'rendering' || status === 'uploading'

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
        : { kind: 'done', downloadUrl: state.downloadUrl }
    case 'failed':
      return {
        kind: 'failed',
        message: FAILURE_TEXT[state.error?.code ?? ''] ?? '整片导出失败，请重新导出',
      }
    case 'cancelled':
      return { kind: 'cancelled' }
  }
}

/**
 * 导出整片：先把手上的改动存好，按存好的那一版提交，轮询进度直到结束；完成后下载，
 * 下载时对这次用到的每条成片各记一次 `video.downloaded`（同一次导出里每条只记一次）。
 *
 * `settle` 存好草稿并给出服务端那一版的 revision，存不好时为 undefined（原因由草稿那边显示）。
 */
export function useWholeFilmExport(
  conversationId: string,
  settle: () => Promise<number | undefined>,
) {
  const [started, setStarted] = useState<Started | null>(null)
  const [local, setLocal] = useState<ExportView>({ kind: 'idle' })
  const recordedRef = useRef(new Map<string, Set<string>>())

  const progress = useQuery({
    queryKey: ['whole-film', 'export', conversationId, started?.exportId],
    queryFn: () => readWholeFilmExport(conversationId, started?.exportId ?? ''),
    enabled: started !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || isRunning(query.state.data.status) ? POLL_MS : false,
    retry: false,
    gcTime: 0,
  })

  const view: ExportView =
    started === null
      ? local
      : progress.isError
        ? { kind: 'failed', message: errorMessageOf(progress.error, '读取导出进度失败') }
        : progress.data === undefined
          ? { kind: 'queued', ahead: null }
          : viewOf(progress.data)

  // 关掉编辑器时还在排队、渲染或上传的导出一并取消：顶栏的进度随编辑器消失，没人会来下载
  const runningRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useLayoutEffect(() => {
    runningRef.current =
      started !== null &&
      (view.kind === 'queued' || view.kind === 'rendering' || view.kind === 'uploading')
        ? started.exportId
        : null
  })
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (runningRef.current !== null) cancelOnClose(conversationId, runningRef.current)
    }
  }, [conversationId])

  const submit = async (revision: number) => {
    try {
      return await startWholeFilmExport(conversationId, revision)
    } catch (error) {
      // 草稿在提交前又被存了一版：再存一次手上的，按新的那一版重提一次
      if (!(error instanceof ApiError) || error.status !== 409) throw error
      const latest = await settle()
      if (latest === undefined) return undefined
      return startWholeFilmExport(conversationId, latest)
    }
  }

  const start = async () => {
    setStarted(null)
    setLocal({ kind: 'starting' })
    const revision = await settle()
    if (revision === undefined) {
      setLocal({ kind: 'idle' })
      return
    }
    try {
      const result = await submit(revision)
      if (result === undefined) {
        setLocal({ kind: 'idle' })
        return
      }
      // 提交还没回来编辑器就关了：受理的这一个也取消
      if (!mountedRef.current) {
        cancelOnClose(conversationId, result.exportId)
        return
      }
      setStarted({ exportId: result.exportId, sourceJobIds: result.sourceJobIds })
    } catch (error) {
      setLocal({ kind: 'failed', message: errorMessageOf(error, '整片导出失败') })
    }
  }

  const cancel = async () => {
    if (started === null) return
    try {
      await cancelWholeFilmExport(conversationId, started.exportId)
      await progress.refetch()
    } catch (error) {
      setStarted(null)
      setLocal({ kind: 'failed', message: errorMessageOf(error, '取消导出失败') })
    }
  }

  /** 点了下载：这次导出用到的成片各记一次下载 */
  const recordDownload = () => {
    if (started === null) return
    const recorded = recordedRef.current.get(started.exportId) ?? new Set<string>()
    recordedRef.current.set(started.exportId, recorded)
    for (const jobId of started.sourceJobIds) {
      if (recorded.has(jobId)) continue
      recorded.add(jobId)
      recordVideoDownloaded(jobId)
    }
  }

  return { view, start, cancel, recordDownload }
}
