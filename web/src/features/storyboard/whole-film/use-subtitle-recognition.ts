import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { toast } from '@/shared/ui/toast'
import { byCreation } from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  submitSubtitle,
  useConversationSubtitles,
  useConversationTaskId,
  wholeFilmQueryKeys,
} from './whole-film.api'

/** 进度与重试范围直接取服务端记录；这里只持有本次请求是否正在提交。 */
export function useSubtitleRecognition({
  conversationId,
  sourceJobIds,
}: {
  conversationId: string
  sourceJobIds: readonly string[]
}) {
  const queryClient = useQueryClient()
  const subtitles = useConversationSubtitles(conversationId)
  const task = useConversationTaskId(conversationId)
  const inFlightRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const ids = [...new Set(sourceJobIds)]
  const jobs = (subtitles.data ?? [])
    .filter((job) => ids.some((id) => id === job.sourceJobId))
    .toSorted((a, b) => byCreation(b, a))
  const sources = ids.map((id) => ({ id, job: jobs.find((job) => job.sourceJobId === id) }))
  const incomplete = sources.filter(({ job }) => job === undefined || job.status === 'failed')
  const failed = sources.find(({ job }) => job?.status === 'failed')?.job
  const sentenceCount = sources.reduce((count, { job }) => count + (job?.sentences?.length ?? 0), 0)
  const failedRead = subtitles.isError ? subtitles : task.isError ? task : undefined
  const loading = subtitles.isPending || task.isPending
  const busy =
    loading ||
    submitting ||
    (failedRead === undefined && jobs.some((job) => isRunningStatus(job.status)))
  const status =
    ids.length === 0
      ? 'no-video'
      : loading
        ? 'loading'
        : failedRead !== undefined
          ? 'read-error'
          : busy
            ? 'running'
            : failed !== undefined
              ? 'failed'
              : incomplete.length > 0
                ? 'unrecognized'
                : sentenceCount === 0
                  ? 'empty'
                  : 'completed'
  const accessibleLabel =
    status === 'read-error'
      ? `重新读取${subtitles.isError ? '字幕记录' : '对话信息'}`
      : status === 'failed'
        ? '重试字幕识别'
        : status === 'completed' || status === 'empty'
          ? '重新识别字幕'
          : '识别字幕'
  const message = {
    'no-video': '成片中没有视频，请先加入镜头',
    loading: '正在读取识别信息…',
    'read-error': `${errorMessageOf(failedRead?.error, '识别信息读取失败')}，请重试读取`,
    running: submitting ? '正在提交字幕识别…' : '正在识别口播…',
    failed: `${failed?.errorMessage ?? '字幕识别失败'}，请重试`,
    unrecognized: '有视频尚未识别，请识别字幕',
    empty: '未识别到口播，可重新识别',
    completed: `已有 ${sentenceCount} 句字幕，可重新识别`,
  }[status]

  const recognize = async () => {
    if (inFlightRef.current || busy || ids.length === 0) return
    if (failedRead !== undefined) {
      await failedRead.refetch()
      return
    }
    if (!task.isSuccess) return
    inFlightRef.current = true
    setSubmitting(true)
    const queryKey = wholeFilmQueryKeys.subtitles(conversationId)
    try {
      // 不让提交前的读取响应盖掉刚受理的任务。
      await queryClient.cancelQueries({ queryKey })
      const targets = incomplete.length > 0 ? incomplete.map(({ id }) => id) : ids
      for (const sourceJobId of targets) {
        const job = await submitSubtitle({ conversationId, sourceJobId, taskId: task.data })
        queryClient.setQueryData<GenerationJob[]>(queryKey, (previous) => [
          job,
          ...(previous ?? []),
        ])
      }
    } catch (error) {
      toast.error(
        `${errorMessageOf(error, '字幕识别提交失败')}；提交已中断，尚未提交的视频需重新发起`,
      )
    } finally {
      await queryClient.invalidateQueries({ queryKey })
      inFlightRef.current = false
      setSubmitting(false)
    }
  }

  return {
    records: subtitles.data,
    status,
    accessibleLabel,
    message,
    busy,
    disabled: busy || ids.length === 0,
    recognize,
  }
}
