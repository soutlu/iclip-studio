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
  /** 「字幕」页签可见且当前是原文时为真；为假时不读识别记录，答复空表。 */
  enabled: boolean
  clips: readonly FilmClip[]
  /** 视频片段的地址对上的素材片记录编号。 */
  takeOf: (src: string) => string | undefined
  /** 对话里的素材片记录。 */
  takes: readonly GenerationJob[] | undefined
}

/**
 * 和台词不一样的字幕：字幕编号 → 台词对照（见 `captionScripts`）。只读名下有字幕、且有台词的素材片已有的字幕识别
 * 记录，不发起识别。
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
