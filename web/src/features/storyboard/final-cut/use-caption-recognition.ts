import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { RecognitionTarget, Sentence } from './caption-edit'
import { submitSubtitles, subtitleJobsQuery } from './final-cut.api'

/** 一条素材片的识别结果：识别出的句子，或者识别失败了。 */
export type RecognitionOutcome =
  { kind: 'ready'; sentences: readonly Sentence[] } | { kind: 'failed' }

/** 一条素材片的字幕识别记录（新的在前）里最新一条完成的识别出的句子；没有完成的时是 undefined。 */
export const recognizedSentences = (
  jobs: readonly GenerationJob[],
): readonly Sentence[] | undefined =>
  jobs.find((job) => job.status === 'completed' && job.sentences !== null)?.sentences ?? undefined

/** 一条素材片的字幕识别记录（新的在前）现在能用到什么：有完成的就用它，没有时看有没有还在识别的。 */
const subtitleStateOf = (
  jobs: readonly GenerationJob[],
): RecognitionOutcome | { kind: 'running' } | { kind: 'none' } => {
  const sentences = recognizedSentences(jobs)
  if (sentences !== undefined) return { kind: 'ready', sentences }
  return jobs.some((job) => isRunningStatus(job.status)) ? { kind: 'running' } : { kind: 'none' }
}

/**
 * 一次识别：要识别的视频片段，它们用到的素材片（不重复），还在查记录、发起识别时 `submitting` 为真，
 * `failed` 是查记录或发起识别出错的素材片。
 */
type Run = {
  clipIds: readonly string[]
  sources: readonly string[]
  submitting: boolean
  failed: ReadonlySet<string>
}

/** 结束了的一次识别：要识别的视频片段，素材片 → 结果。 */
type Finished = {
  clipIds: readonly string[]
  outcomes: ReadonlyMap<string, RecognitionOutcome>
}

/** 各素材片都有了结果时是素材片 → 结果；还有在识别的时是 undefined。 */
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
    // 这次已经按需发起过：没有完成的记录就是发起的那条失败了
    outcomes.set(source, state.kind === 'none' ? { kind: 'failed' } : state)
  }
  return outcomes
}

/**
 * 「识别字幕」：对几个视频片段用到的素材片，各自有完成的字幕记录就用，在识别中的就等着，都没有或上次失败了才
 * 发起识别（同一条素材片只发起一次；发起只在 `start` 里做，轮询到失败也不会再发）。轮询照生成记录的写法。
 * 全部有了结果后调一次 `onDone`（要识别的片段、素材片 → 结果）。识别中再调 `start` 不做任何事。
 */
export function useCaptionRecognition(
  conversationId: string,
  onDone: (clipIds: readonly string[], outcomes: ReadonlyMap<string, RecognitionOutcome>) => void,
) {
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run | null>(null)
  // 状态要到下一次渲染才变：连点两下时靠它挡住第二次发起
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
          // 读不到记录、发起不了：这条素材片算识别失败，结束后连同别的失败一起提示
          failed.add(source)
        }
      }),
    )
    setRun({ clipIds, sources, submitting: false, failed })
  }

  // 全部有了结果：这次识别结束，结果交给下面的副作用调 `onDone`
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
    /** 正在识别几个视频片段；没在识别时是 0。 */
    recognizing: run?.clipIds.length ?? 0,
    start,
  }
}
