import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { isRunningStatus } from '../shots'
import type { DubbingLine } from '@/shared/api/generated/types.gen'
import type { GenerationJob } from '../storyboard.api'
import type { VoiceSetting } from './composition/voices'
import type { DubbingRequest, DubLine } from './dubbing'
import { dubbingJobsQuery, submitDubbing } from './final-cut.api'
import type { LocaleCode } from './locales'

/** 一次配音请求的结果：配好的记录，或者失败了和原因。 */
export type DubbingOutcome =
  { kind: 'ready'; job: GenerationJob } | { kind: 'failed'; message: string }

/** 要发的一次配音请求：素材片、音色、要配的各句和素材片对上的生成记录。 */
export type DubbingTarget = DubbingRequest & { sourceJobId: string }

/** 配好以后这种语言的人声设置怎么改（整种语言换音色、改一句的选择……），由发起的一方给。 */
export type VoiceUpdate = (setting: VoiceSetting) => VoiceSetting

/** 发起一次请求的结果：配音记录的编号，或者发起不了的原因。 */
type Submitted = { job: string } | { failed: string }

/**
 * 一次生成：哪种语言、各次请求、配好以后人声设置怎么改；`submitted` 和 `targets` 一一对应，还在发起时是 null。
 */
type Run = {
  locale: LocaleCode
  targets: readonly DubbingTarget[]
  update: VoiceUpdate
  submitted: readonly Submitted[] | null
}

/** 结束了的一次生成：哪种语言、人声设置怎么改、每次请求和它的结果。 */
export type DubbingDone = {
  locale: LocaleCode
  update: VoiceUpdate
  results: readonly { target: DubbingTarget; outcome: DubbingOutcome }[]
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

const sourcesOf = (targets: readonly DubbingTarget[]) => [
  ...new Set(targets.map((target) => target.sourceJobId)),
]

/** 各次请求的结果；还有在配的时是 undefined。`records` 是素材片 → 读到的配音记录。 */
const outcomesOf = (
  targets: readonly DubbingTarget[],
  submitted: readonly Submitted[],
  records: ReadonlyMap<string, UseQueryResult<GenerationJob[]>>,
): DubbingDone['results'] | undefined => {
  const done: { target: DubbingTarget; outcome: DubbingOutcome }[] = []
  for (const [index, target] of targets.entries()) {
    const sent = submitted[index]
    if (sent === undefined) return undefined
    if ('failed' in sent) {
      done.push({ target, outcome: { kind: 'failed', message: sent.failed } })
      continue
    }
    const result = records.get(target.sourceJobId)
    if (result?.data === undefined) {
      if (result?.isError !== true) return undefined
      done.push({ target, outcome: { kind: 'failed', message: READ_FAILED_TEXT } })
      continue
    }
    const job = result.data.find((each) => each.id === sent.job)
    if (job === undefined || isRunningStatus(job.status)) return undefined
    done.push({
      target,
      outcome:
        job.status === 'completed' && job.outputUrl !== null
          ? { kind: 'ready', job }
          : { kind: 'failed', message: job.errorMessage?.trim() || FAILED_TEXT },
    })
  }
  return done
}

/** 发给接口的一句：去掉编辑器自己用的字幕编号，没有上限时不写 `slotEndMs`。 */
const sentLine = ({ startMs, endMs, text, slotEndMs }: DubLine): DubbingLine =>
  slotEndMs === undefined || slotEndMs === null
    ? { startMs, endMs, text }
    : { startMs, endMs, text, slotEndMs }

/**
 * 「AI 配音」的生成：给一种语言发几次配音请求（每次一条素材片、一个音色：参考音频库里的音色，null 是从素材片的
 * 原声里取；付费的发起只在 `start` 里做），轮询各条素材片的配音记录（照生成记录的写法；同一条素材片几次请求共用），
 * 全部有了结果后调一次 `onDone`（语言、人声设置怎么改、每次请求和结果）。发起时接口答错（比如 422 没开通）的
 * 那次算失败，原因是接口给的说明。生成中再调 `start` 不做任何事。
 */
export function useDubbing(conversationId: string, onDone: (done: DubbingDone) => void) {
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run | null>(null)
  // 状态要到下一次渲染才变：连点两下时靠它挡住第二次发起
  const busyRef = useRef(false)
  const watched = run === null || run.submitted === null ? [] : sourcesOf(run.targets)
  const results = useQueries({
    queries: watched.map((sourceJobId) => dubbingJobsQuery(conversationId, sourceJobId)),
  })

  const start = async (
    locale: LocaleCode,
    targets: readonly DubbingTarget[],
    update: VoiceUpdate,
  ) => {
    if (busyRef.current || targets.length === 0) return
    busyRef.current = true
    setRun({ locale, targets, update, submitted: null })
    const submitted = await Promise.all(
      targets.map(async ({ sourceJobId, voice, lines, spans }): Promise<Submitted> => {
        try {
          const job = await submitDubbing({
            conversationId,
            sourceJobId,
            locale,
            lines: lines.map(sentLine),
            reference:
              voice === null
                ? { kind: 'original', spans: [...spans] }
                : { kind: 'reference_audio', referenceId: voice },
          })
          queryClient.setQueryData(
            dubbingJobsQuery(conversationId, sourceJobId).queryKey,
            (stored) => [job, ...(stored ?? [])],
          )
          return { job: job.id }
        } catch (error) {
          return { failed: submitFailure(error) }
        }
      }),
    )
    setRun({ locale, targets, update, submitted })
  }

  // 全部有了结果：这次生成结束，结果交给下面的副作用调 `onDone`
  const [finished, setFinished] = useState<DubbingDone | null>(null)
  const records = new Map(
    watched.flatMap((sourceJobId, index) => {
      const result = results[index]
      return result === undefined ? [] : [[sourceJobId, result] as const]
    }),
  )
  const done =
    run === null || run.submitted === null
      ? undefined
      : outcomesOf(run.targets, run.submitted, records)
  if (run !== null && done !== undefined) {
    setRun(null)
    setFinished({ locale: run.locale, update: run.update, results: done })
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
    generating: run === null ? 0 : sourcesOf(run.targets).length,
    start,
  }
}
