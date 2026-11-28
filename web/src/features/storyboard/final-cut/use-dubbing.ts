import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { isRunningStatus } from '../shots'
import type { DubbingLine } from '@/shared/api/generated/types.gen'
import type { GenerationJob } from '../storyboard.api'
import type { DubbingRequest, DubLine, NarrationLine } from './dubbing'
import { dubbingJobsQuery, speechJobsQuery, submitDubbing, submitSpeech } from './final-cut.api'
import { SOURCE_LOCALE, type Language } from './locales'

/** 一次请求的结果：配好的记录，或者失败了和原因。 */
export type DubbingOutcome =
  { kind: 'ready'; job: GenerationJob } | { kind: 'failed'; message: string }

/** 要发的一次配音请求：素材片、音色、要配的各句和素材片对上的生成记录。 */
export type DubbingTarget = DubbingRequest & { sourceJobId: string }

/** 一次生成要发的：各条素材片的配音请求和旁白句的各句（每句一次按文字合成）。 */
export type DubbingWork = {
  takes: readonly DubbingTarget[]
  narrations: readonly NarrationLine[]
}

/** 发起一次请求的结果：记录的编号，或者发起不了的原因。 */
type Submitted = { job: string } | { failed: string }

/** 一次生成：哪种语言、要发的；`submitted` 和要发的一一对应，还在发起时是 null。 */
type Run = {
  locale: Language
  work: DubbingWork
  submitted: { takes: readonly Submitted[]; narrations: readonly Submitted[] } | null
}

/** 结束了的一次生成：哪种语言、每次素材片的请求和旁白句的每句和它们的结果。 */
export type DubbingDone = {
  locale: Language
  results: readonly { target: DubbingTarget; outcome: DubbingOutcome }[]
  narrations: readonly { line: NarrationLine; outcome: DubbingOutcome }[]
}

/**
 * 正在跑的一批：哪种语言，`lines` 是这批要配的句子（字幕编号；写进工程以前都算在合成），`remaining` 是还没有结果的
 * 句数。
 */
export type DubbingRunning = { locale: Language; lines: ReadonlySet<string>; remaining: number }

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

/** 一次请求的结果（`records` 是读到的它那一类记录）；还在配时是 undefined。 */
const outcomeOf = (
  sent: Submitted | undefined,
  records: UseQueryResult<GenerationJob[]> | undefined,
): DubbingOutcome | undefined => {
  if (sent === undefined) return undefined
  if ('failed' in sent) return { kind: 'failed', message: sent.failed }
  if (records?.data === undefined)
    return records?.isError === true ? { kind: 'failed', message: READ_FAILED_TEXT } : undefined
  const job = records.data.find((each) => each.id === sent.job)
  if (job === undefined || isRunningStatus(job.status)) return undefined
  return job.status === 'completed' && job.outputUrl !== null
    ? { kind: 'ready', job }
    : { kind: 'failed', message: job.errorMessage?.trim() || FAILED_TEXT }
}

/** `items` 各自的结果（`sent` 和它一一对应，还在发起时是空的）；还有在配的时是 undefined。 */
const outcomesOf = <T>(
  items: readonly T[],
  sent: readonly Submitted[],
  recordsOf: (item: T) => UseQueryResult<GenerationJob[]> | undefined,
): { item: T; outcome: DubbingOutcome }[] | undefined => {
  const done: { item: T; outcome: DubbingOutcome }[] = []
  for (const [index, item] of items.entries()) {
    const outcome = outcomeOf(sent[index], recordsOf(item))
    if (outcome === undefined) return undefined
    done.push({ item, outcome })
  }
  return done
}

/** 发给接口的一句：去掉编辑器自己用的字幕编号，没有上限时不写 `slotEndMs`。 */
const sentLine = ({ startMs, endMs, text, slotEndMs }: DubLine): DubbingLine =>
  slotEndMs === undefined || slotEndMs === null
    ? { startMs, endMs, text }
    : { startMs, endMs, text, slotEndMs }

/** 原文不声明语言：请求里不写 `locale`。 */
const localeField = (locale: Language) => (locale === SOURCE_LOCALE ? {} : { locale })

/**
 * 配音的生成：给一种语言（原文也行）发几次配音请求（每次一条素材片、一个音色：参考音频库里的音色，null 是从
 * 素材片的原声里取）和旁白句的每句一次按文字合成，原文下都不声明语言；付费的发起只在 `start` 里做。轮询各条素材片
 * 的配音记录和这段对话的合成记录（照生成记录的写法），全部有了结果后调一次 `onDone`（语言、每次请求和结果）。
 * 发起时接口答错（比如 422 没开通）的那次算失败，原因是接口给的说明。同一时间只跑一批：生成中再调 `start` 不做
 * 任何事。
 */
export function useDubbing(conversationId: string, onDone: (done: DubbingDone) => void) {
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run | null>(null)
  // 状态要到下一次渲染才变：连点两下时靠它挡住第二次发起
  const busyRef = useRef(false)
  const submitted = run?.submitted ?? null
  const watched = run === null || submitted === null ? [] : sourcesOf(run.work.takes)
  const speaking = run !== null && submitted !== null && run.work.narrations.length > 0
  const results = useQueries({
    queries: [
      ...watched.map((sourceJobId) => dubbingJobsQuery(conversationId, sourceJobId)),
      ...(speaking ? [speechJobsQuery(conversationId)] : []),
    ],
  })

  const submitTake = async (
    locale: Language,
    { sourceJobId, voice, lines, spans }: DubbingTarget,
  ): Promise<Submitted> => {
    try {
      const job = await submitDubbing({
        conversationId,
        sourceJobId,
        ...localeField(locale),
        lines: lines.map(sentLine),
        reference:
          voice === null
            ? { kind: 'original', spans: [...spans] }
            : { kind: 'reference_audio', referenceId: voice },
      })
      queryClient.setQueryData(dubbingJobsQuery(conversationId, sourceJobId).queryKey, (stored) => [
        job,
        ...(stored ?? []),
      ])
      return { job: job.id }
    } catch (error) {
      return { failed: submitFailure(error) }
    }
  }

  const submitNarration = async (locale: Language, line: NarrationLine): Promise<Submitted> => {
    try {
      const job = await submitSpeech({
        conversationId,
        text: line.text,
        ...localeField(locale),
        reference: { kind: 'reference_audio', referenceId: line.voice },
        ...(line.maxMs === undefined ? {} : { maxDurationMs: line.maxMs }),
      })
      queryClient.setQueryData(speechJobsQuery(conversationId).queryKey, (stored) => [
        job,
        ...(stored ?? []),
      ])
      return { job: job.id }
    } catch (error) {
      return { failed: submitFailure(error) }
    }
  }

  const start = async (locale: Language, work: DubbingWork) => {
    if (busyRef.current || work.takes.length + work.narrations.length === 0) return
    busyRef.current = true
    setRun({ locale, work, submitted: null })
    const [takeResults, narrationResults] = await Promise.all([
      Promise.all(work.takes.map((target) => submitTake(locale, target))),
      Promise.all(work.narrations.map((line) => submitNarration(locale, line))),
    ])
    setRun({ locale, work, submitted: { takes: takeResults, narrations: narrationResults } })
  }

  // 各次请求的结果（还没有的是 undefined）；全部有了时这次生成结束，结果交给下面的副作用调 `onDone`
  const [finished, setFinished] = useState<DubbingDone | null>(null)
  const records = new Map(
    watched.flatMap((sourceJobId, index) => {
      const result = results[index]
      return result === undefined ? [] : [[sourceJobId, result] as const]
    }),
  )
  const spoken = speaking ? results[watched.length] : undefined
  const takesDone =
    run === null
      ? undefined
      : outcomesOf(run.work.takes, submitted?.takes ?? [], (target) =>
          records.get(target.sourceJobId),
        )
  const narrationsDone =
    run === null
      ? undefined
      : outcomesOf(run.work.narrations, submitted?.narrations ?? [], () => spoken)
  if (run !== null && takesDone !== undefined && narrationsDone !== undefined) {
    setRun(null)
    setFinished({
      locale: run.locale,
      results: takesDone.map(({ item, outcome }) => ({ target: item, outcome })),
      narrations: narrationsDone.map(({ item, outcome }) => ({ line: item, outcome })),
    })
  }
  const deliver = useEffectEvent((done: DubbingDone) => {
    busyRef.current = false
    onDone(done)
  })
  useEffect(() => {
    if (finished !== null) deliver(finished)
  }, [finished])

  const running: DubbingRunning | null =
    run === null
      ? null
      : {
          locale: run.locale,
          lines: new Set([
            ...run.work.takes.flatMap(({ lines }) => lines.map((line) => line.caption)),
            ...run.work.narrations.map(({ caption }) => caption),
          ]),
          remaining:
            run.work.takes.reduce(
              (total, target, index) =>
                outcomeOf(submitted?.takes[index], records.get(target.sourceJobId)) === undefined
                  ? total + target.lines.length
                  : total,
              0,
            ) +
            run.work.narrations.filter(
              (_, index) => outcomeOf(submitted?.narrations[index], spoken) === undefined,
            ).length,
        }

  return {
    /** 正在跑的一批（见 `DubbingRunning`）；没在跑时是 null。 */
    running,
    start,
  }
}
