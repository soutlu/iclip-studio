import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { DubbingRequest } from './dubbing'
import { dubbingJobsQuery, submitDubbing } from './final-cut.api'
import type { LocaleCode } from './locales'

/** 一条素材片的配音：配好的记录，或者失败了和原因。 */
export type DubbingOutcome =
  { kind: 'ready'; job: GenerationJob } | { kind: 'failed'; message: string }

/** 要配音的一条素材片：要配的各句和它对上的生成记录。 */
export type DubbingTarget = DubbingRequest & { sourceJobId: string }

/**
 * 一次生成：哪种语言、用的音色、各条素材片，还在发起时 `submitting` 为真；`jobs` 是发起成功的素材片 → 配音记录，
 * `failed` 是发起不了的素材片 → 原因。
 */
type Run = {
  locale: LocaleCode
  voice: string | null
  targets: readonly DubbingTarget[]
  submitting: boolean
  jobs: ReadonlyMap<string, string>
  failed: ReadonlyMap<string, string>
}

/** 结束了的一次生成：哪种语言、用的音色（null 是原声的音色）、各条素材片，素材片 → 结果。 */
export type DubbingDone = {
  locale: LocaleCode
  voice: string | null
  targets: readonly DubbingTarget[]
  outcomes: ReadonlyMap<string, DubbingOutcome>
}

const READ_FAILED_TEXT = '读取配音记录失败，请重试'
const FAILED_TEXT = '配音生成失败，请重试'

/** 发起不了的原因：接口答了说明（比如 422「配音没有开通」）就照原样用，别的失败用通用的说法。 */
const submitFailure = (error: unknown): string => {
  const body = error instanceof ApiError ? error.body : undefined
  const detail =
    typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined
  return typeof detail === 'string' && detail.trim() !== ''
    ? detail.trim()
    : errorMessageOf(error, FAILED_TEXT)
}

/** 各条素材片都有了结果时是素材片 → 结果；还有在配的时是 undefined。 */
const outcomesOf = (
  run: Run,
  results: readonly UseQueryResult<GenerationJob[]>[],
): ReadonlyMap<string, DubbingOutcome> | undefined => {
  const outcomes = new Map<string, DubbingOutcome>()
  for (const [index, { sourceJobId }] of run.targets.entries()) {
    const failed = run.failed.get(sourceJobId)
    if (failed !== undefined) {
      outcomes.set(sourceJobId, { kind: 'failed', message: failed })
      continue
    }
    const result = results[index]
    if (result?.data === undefined) {
      if (result?.isError !== true) return undefined
      outcomes.set(sourceJobId, { kind: 'failed', message: READ_FAILED_TEXT })
      continue
    }
    const job = result.data.find((each) => each.id === run.jobs.get(sourceJobId))
    if (job === undefined || isRunningStatus(job.status)) return undefined
    outcomes.set(
      sourceJobId,
      job.status === 'completed' && job.outputUrl !== null
        ? { kind: 'ready', job }
        : { kind: 'failed', message: job.errorMessage?.trim() || FAILED_TEXT },
    )
  }
  return outcomes
}

/**
 * 「AI 配音」的生成：用一个音色（参考音频库里的音色，null 是从各条素材片的原声里取）给一种语言的几条素材片各发起
 * 一次配音（付费的发起只在 `start` 里做），轮询各自的配音记录（照生成记录的写法），全部有了结果后调一次 `onDone`
 * （语言、音色、各条素材片、素材片 → 结果）。发起时接口答错（比如 422 没开通）的那条算失败，原因是接口给的说明。
 * 生成中再调 `start` 不做任何事。
 */
export function useDubbing(conversationId: string, onDone: (done: DubbingDone) => void) {
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run | null>(null)
  // 状态要到下一次渲染才变：连点两下时靠它挡住第二次发起
  const busyRef = useRef(false)
  const watched = run === null || run.submitting ? [] : run.targets
  const results = useQueries({
    queries: watched.map((target) => dubbingJobsQuery(conversationId, target.sourceJobId)),
  })

  const start = async (
    locale: LocaleCode,
    voice: string | null,
    targets: readonly DubbingTarget[],
  ) => {
    if (busyRef.current || targets.length === 0) return
    busyRef.current = true
    const empty = new Map<string, string>()
    setRun({ locale, voice, targets, submitting: true, jobs: empty, failed: empty })
    const jobs = new Map<string, string>()
    const failed = new Map<string, string>()
    await Promise.all(
      targets.map(async ({ sourceJobId, lines }) => {
        try {
          const job = await submitDubbing({
            conversationId,
            sourceJobId,
            locale,
            lines: lines.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
            reference:
              voice === null
                ? { kind: 'original' }
                : { kind: 'reference_audio', referenceId: voice },
          })
          jobs.set(sourceJobId, job.id)
          queryClient.setQueryData(
            dubbingJobsQuery(conversationId, sourceJobId).queryKey,
            (stored) => [job, ...(stored ?? [])],
          )
        } catch (error) {
          failed.set(sourceJobId, submitFailure(error))
        }
      }),
    )
    setRun({ locale, voice, targets, submitting: false, jobs, failed })
  }

  // 全部有了结果：这次生成结束，结果交给下面的副作用调 `onDone`
  const [finished, setFinished] = useState<DubbingDone | null>(null)
  const outcomes = run === null || run.submitting ? undefined : outcomesOf(run, results)
  if (run !== null && outcomes !== undefined) {
    setRun(null)
    setFinished({ locale: run.locale, voice: run.voice, targets: run.targets, outcomes })
  }
  const deliver = useEffectEvent((done: DubbingDone) => {
    busyRef.current = false
    onDone(done)
  })
  useEffect(() => {
    if (finished !== null) deliver(finished)
  }, [finished])

  return {
    /** 正在给几条素材片配音；没在配时是 0。 */
    generating: run?.targets.length ?? 0,
    start,
  }
}
