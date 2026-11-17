import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { isRunningStatus } from '../shots'
import type { DubbingLine } from '@/shared/api/generated/types.gen'
import type { GenerationJob } from '../storyboard.api'
import type { VoiceSetting } from './composition/voices'
import type { DubbingRequest, DubLine, NarrationLine } from './dubbing'
import { dubbingJobsQuery, speechJobsQuery, submitDubbing, submitSpeech } from './final-cut.api'
import { SOURCE_LOCALE, type Language, type LocaleCode } from './locales'

/** 一次请求的结果：配好的记录，或者失败了和原因。 */
export type DubbingOutcome =
  { kind: 'ready'; job: GenerationJob } | { kind: 'failed'; message: string }

/** 要发的一次配音请求：素材片、音色、要配的各句和素材片对上的生成记录。 */
export type DubbingTarget = DubbingRequest & { sourceJobId: string }

/** 一次生成要发的：各条素材片的配音请求和旁白的各句（每句一次按文字合成）。 */
export type DubbingWork = {
  takes: readonly DubbingTarget[]
  narrations: readonly NarrationLine[]
}

/** 配好以后这种语言的人声设置怎么改（整种语言换音色、改一句的选择……），由发起的一方给。 */
export type VoiceUpdate = (setting: VoiceSetting) => VoiceSetting

/** 发起一次请求的结果：记录的编号，或者发起不了的原因。 */
type Submitted = { job: string } | { failed: string }

/**
 * 一次生成：哪种语言、要发的、配好以后人声设置怎么改；`submitted` 和要发的一一对应，还在发起时是 null。
 */
type Run = {
  locale: Language
  work: DubbingWork
  update: VoiceUpdate
  submitted: { takes: readonly Submitted[]; narrations: readonly Submitted[] } | null
}

/** 结束了的一次生成：哪种语言、人声设置怎么改、每次素材片的请求和旁白的每句和它们的结果。 */
export type DubbingDone = {
  locale: Language
  update: VoiceUpdate
  results: readonly { target: DubbingTarget; outcome: DubbingOutcome }[]
  narrations: readonly { line: NarrationLine; outcome: DubbingOutcome }[]
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

/** 一次请求的结果（`records` 是读到的它那一类记录）；还在配时是 undefined。 */
const outcomeOf = (
  sent: Submitted,
  records: UseQueryResult<GenerationJob[]> | undefined,
): DubbingOutcome | undefined => {
  if ('failed' in sent) return { kind: 'failed', message: sent.failed }
  if (records?.data === undefined)
    return records?.isError === true ? { kind: 'failed', message: READ_FAILED_TEXT } : undefined
  const job = records.data.find((each) => each.id === sent.job)
  if (job === undefined || isRunningStatus(job.status)) return undefined
  return job.status === 'completed' && job.outputUrl !== null
    ? { kind: 'ready', job }
    : { kind: 'failed', message: job.errorMessage?.trim() || FAILED_TEXT }
}

/** `items` 各自的结果（`sent` 和它一一对应）；还有在配的时是 undefined。 */
const outcomesOf = <T>(
  items: readonly T[],
  sent: readonly Submitted[],
  recordsOf: (item: T) => UseQueryResult<GenerationJob[]> | undefined,
): { item: T; outcome: DubbingOutcome }[] | undefined => {
  const done: { item: T; outcome: DubbingOutcome }[] = []
  for (const [index, item] of items.entries()) {
    const each = sent[index]
    const outcome = each === undefined ? undefined : outcomeOf(each, recordsOf(item))
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

/**
 * 「AI 配音」和旁白配音的生成：给一种语言发几次配音请求（每次一条素材片、一个音色：参考音频库里的音色，null 是从
 * 素材片的原声里取）和旁白的每句一次按文字合成（原文下不声明语言；原文下只有旁白，`work.takes` 不发）；付费的发起
 * 只在 `start` 里做。轮询各条素材片的配音记录和这段对话的合成记录（照生成记录的写法），全部有了结果后调一次
 * `onDone`（语言、人声设置怎么改、每次请求和结果）。发起时接口答错（比如 422 没开通）的那次算失败，原因是接口
 * 给的说明。生成中再调 `start` 不做任何事。
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
    locale: LocaleCode,
    { sourceJobId, voice, lines, spans }: DubbingTarget,
  ): Promise<Submitted> => {
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
        ...(locale === SOURCE_LOCALE ? {} : { locale }),
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

  const start = async (locale: Language, work: DubbingWork, update: VoiceUpdate) => {
    const takes = locale === SOURCE_LOCALE ? [] : work.takes
    if (busyRef.current || takes.length + work.narrations.length === 0) return
    busyRef.current = true
    const sent = { takes, narrations: work.narrations }
    setRun({ locale, work: sent, update, submitted: null })
    const [takeResults, narrationResults] = await Promise.all([
      Promise.all(
        locale === SOURCE_LOCALE ? [] : takes.map((target) => submitTake(locale, target)),
      ),
      Promise.all(work.narrations.map((line) => submitNarration(locale, line))),
    ])
    setRun({
      locale,
      work: sent,
      update,
      submitted: { takes: takeResults, narrations: narrationResults },
    })
  }

  // 全部有了结果：这次生成结束，结果交给下面的副作用调 `onDone`
  const [finished, setFinished] = useState<DubbingDone | null>(null)
  const records = new Map(
    watched.flatMap((sourceJobId, index) => {
      const result = results[index]
      return result === undefined ? [] : [[sourceJobId, result] as const]
    }),
  )
  const spoken = speaking ? results[watched.length] : undefined
  const takesDone =
    run === null || submitted === null
      ? undefined
      : outcomesOf(run.work.takes, submitted.takes, (target) => records.get(target.sourceJobId))
  const narrationsDone =
    run === null || submitted === null
      ? undefined
      : outcomesOf(run.work.narrations, submitted.narrations, () => spoken)
  if (run !== null && takesDone !== undefined && narrationsDone !== undefined) {
    setRun(null)
    setFinished({
      locale: run.locale,
      update: run.update,
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

  return {
    /** 正在给几条素材片配音；没在配时是 0。 */
    generating: run === null ? 0 : sourcesOf(run.work.takes).length,
    /** 正在合成几句旁白；没在合成时是 0。 */
    narrating: run === null ? 0 : run.work.narrations.length,
    start,
  }
}
