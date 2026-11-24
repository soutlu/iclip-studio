import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { GenerationJob } from '../storyboard.api'
import { captionScripts, scriptLinesOf, type ScriptNote } from './caption-script'
import type { FilmClip } from './composition/film'
import { subtitleJobsQuery } from './final-cut.api'
import { recognizedSentences } from './use-caption-recognition'

const sentencesOfResults = (results: readonly UseQueryResult<GenerationJob[]>[]) =>
  results.map((result) =>
    result.data === undefined ? undefined : recognizedSentences(result.data),
  )

type CaptionScriptsInput = {
  conversationId: string
  /** 仅当「字幕」页签可见且处于原文视图时为 `true`；否则不查询识别记录并返回空映射。 */
  enabled: boolean
  clips: readonly FilmClip[]
  /** 按视频片段地址查找对应素材片记录 ID。 */
  takeOf: (src: string) => string | undefined
  /** 当前对话的素材片记录列表。 */
  takes: readonly GenerationJob[] | undefined
}

/**
 * 返回与原始台词存在差异的字幕映射（字幕 ID → 台词对照，见 `captionScripts`）。
 * 仅查询名下有字幕且含台词的素材片已有识别记录，不主动发起识别。
 */
export function useCaptionScripts({
  conversationId,
  enabled,
  clips,
  takeOf,
  takes,
}: CaptionScriptsInput): ReadonlyMap<string, ScriptNote> {
  const linesOf = useMemo(
    () =>
      new Map(
        (takes ?? []).flatMap((job) => {
          const lines = scriptLinesOf(job)
          return lines === null ? [] : [[job.id, lines] as const]
        }),
      ),
    [takes],
  )
  const sources = useMemo(() => {
    if (!enabled) return []
    const videos = new Map(clips.map((clip) => [clip.id, clip]))
    const found = clips.flatMap((clip) => {
      const owner =
        clip.kind === 'caption' && clip.owner !== null ? videos.get(clip.owner) : undefined
      const take = owner?.kind === 'video' ? takeOf(owner.src) : undefined
      return take !== undefined && linesOf.has(take) ? [take] : []
    })
    return [...new Set(found)]
  }, [enabled, clips, takeOf, linesOf])
  const sentences = useQueries({
    queries: sources.map((source) => subtitleJobsQuery(conversationId, source)),
    combine: sentencesOfResults,
  })
  return useMemo(() => {
    const sentencesOf = new Map(
      sources.flatMap((source, index) => {
        const found = sentences[index]
        return found === undefined ? [] : [[source, found] as const]
      }),
    )
    return captionScripts(clips, takeOf, linesOf, sentencesOf)
  }, [clips, takeOf, linesOf, sources, sentences])
}
