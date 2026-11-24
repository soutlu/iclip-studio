import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { RecognitionTarget, Sentence } from './caption-edit'
import { submitSubtitles, subtitleJobsQuery } from './final-cut.api'

/** 单条素材片的字幕识别结果：已识别的句子列表或识别失败。 */
export type RecognitionOutcome =
  { kind: 'ready'; sentences: readonly Sentence[] } | { kind: 'failed' }

/** 从素材片字幕识别记录列表（按创建时间倒序）中取出最新已完成记录的句子列表；无完成记录时返回 `undefined`。 */
export const recognizedSentences = (
  jobs: readonly GenerationJob[],
): readonly Sentence[] | undefined =>
  jobs.find((job) => job.status === 'completed' && job.sentences !== null)?.sentences ?? undefined

/** 判断素材片当前可用的字幕识别状态：优先复用已完成记录，其次等待运行中记录，否则返回 `none`。 */
const subtitleStateOf = (
  jobs: readonly GenerationJob[],
): RecognitionOutcome | { kind: 'running' } | { kind: 'none' } => {
  const sentences = recognizedSentences(jobs)
  if (sentences !== undefined) return { kind: 'ready', sentences }
  return jobs.some((job) => isRunningStatus(job.status)) ? { kind: 'running' } : { kind: 'none' }
}

/**
 * 单次批量识别状态：目标视频片段 ID、去重后的素材片 ID 列表、提交中标记 `submitting`，
 * 以及查询或发起阶段出错的素材片 ID 集合 `failed`。
 */
type Run = {
  clipIds: readonly string[]
  sources: readonly string[]
  submitting: boolean
  failed: ReadonlySet<string>
}

/** 已结束的单次识别批次：目标视频片段 ID 及素材片 → 识别结果映射。 */
type Finished = {
  clipIds: readonly string[]
  outcomes: ReadonlyMap<string, RecognitionOutcome>
}

/** 全部素材片均已产出结果时返回映射表；仍有识别中项时返回 `undefined`。 */
const outcomesOf = (
  run: Run,
  results: readonly UseQueryResult<GenerationJob[]>[],
): ReadonlyMap<string, RecognitionOutcome> | undefined => {
  const outcomes = new Map<string, RecognitionOutcome>()
  for (const [index, source] of run.sources.entries()) {
    const result = results[index]
    if (run.failed.has(source)) {
      outcomes.set(source, { kind: 'failed' })
      continue
    }
    if (result?.data === undefined) {
      if (result?.isError !== true) return undefined
      outcomes.set(source, { kind: 'failed' })
      continue
    }
    const state = subtitleStateOf(result.data)
    if (state.kind === 'running') return undefined
    // 本轮已按需提交识别：仍无完成记录说明已提交任务失败。
    outcomes.set(source, state.kind === 'none' ? { kind: 'failed' } : state)
  }
  return outcomes
}

/**
 * 驱动「识别字幕」流程：对各视频片段关联的素材片，已有完成记录直接复用，运行中则等待轮询结束，
 * 仅当无记录或上次失败时在 `start` 中提交一次识别（轮询到失败不自动重试）。
 * 全部完成后回调一次 `onDone`；识别进行期间再次调用 `start` 忽略。
 */
export function useCaptionRecognition(
  conversationId: string,
  onDone: (clipIds: readonly string[], outcomes: ReadonlyMap<string, RecognitionOutcome>) => void,
) {
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run | null>(null)
  // React 状态更新在下次渲染生效，用 ref 立即拦截连点重复发起。
  const busyRef = useRef(false)
  const watched = run === null || run.submitting ? [] : run.sources
  const results = useQueries({
    queries: watched.map((source) => subtitleJobsQuery(conversationId, source)),
  })

  const start = async (targets: readonly RecognitionTarget[]) => {
    if (busyRef.current || targets.length === 0) return
    busyRef.current = true
    const clipIds = targets.map((target) => target.clipId)
    const sources = [...new Set(targets.map((target) => target.sourceJobId))]
    setRun({ clipIds, sources, submitting: true, failed: new Set() })
    const failed = new Set<string>()
    await Promise.all(
      sources.map(async (source) => {
        const query = subtitleJobsQuery(conversationId, source)
        try {
          const jobs = await queryClient.fetchQuery(query)
          if (subtitleStateOf(jobs).kind !== 'none') return
          const job = await submitSubtitles({ conversationId, sourceJobId: source })
          queryClient.setQueryData(query.queryKey, [job, ...jobs])
        } catch {
          // 查询或提交失败时标记该素材片失败，待整批完成后统一提示。
          failed.add(source)
        }
      }),
    )
    setRun({ clipIds, sources, submitting: false, failed })
  }

  // 全部素材片均已结案时转存结果，由下方副作用统一触发 `onDone`。
  const [finished, setFinished] = useState<Finished | null>(null)
  const outcomes = run === null || run.submitting ? undefined : outcomesOf(run, results)
  if (run !== null && outcomes !== undefined) {
    setRun(null)
    setFinished({ clipIds: run.clipIds, outcomes })
  }
  const deliver = useEffectEvent((done: Finished) => {
    busyRef.current = false
    onDone(done.clipIds, done.outcomes)
  })
  useEffect(() => {
    if (finished !== null) deliver(finished)
  }, [finished])

  return {
    /** 当前正在识别的视频片段数量；空闲时为 0。 */
    recognizing: run?.clipIds.length ?? 0,
    start,
  }
}
