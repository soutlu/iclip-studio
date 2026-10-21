import { queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { byCreation } from '../editing/version-lineage'
import { keyframeQuery } from '../editing/media-analysis'
import type { KeyframeIndex } from '../editing/keyframe-segments'
import type { GenerationJob } from '../storyboard.api'
import type { EditContext, MusicBeat, SourceMedia } from './editing/context'
import type { Material } from './materials'

const loadReader = () => import('../editing/media-file')

/** 一段视频的画面尺寸；第一段加入成片时用它定画布。 */
export const videoSizeQuery = (url: string | undefined) =>
  queryOptions({
    queryKey: ['whole-film', 'video-size', url],
    queryFn:
      url === undefined
        ? skipToken
        : async () => {
            const input = (await loadReader()).openInput(url)
            try {
              const track = await input.getPrimaryVideoTrack()
              if (track === null) throw new UserFacingError('该视频没有画面，无法加入成片')
              return {
                width: await track.getDisplayWidth(),
                height: await track.getDisplayHeight(),
              }
            } finally {
              input.dispose()
            }
          },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

export const useVideoSize = (url: string | undefined) => useQuery(videoSizeQuery(url))

export type KeyframeState =
  | { kind: 'loading' }
  | { kind: 'ready'; index: KeyframeIndex }
  | { kind: 'failed'; message: string }

export type KeyframeStates = ReadonlyMap<string, KeyframeState>

/** 各版素材片的关键帧表（地址 → 表）；时长也取它，记录上没记时长的素材片靠它知道多长。 */
export const useKeyframeIndexes = (urls: readonly string[]): KeyframeStates =>
  useQueries({
    queries: urls.map((url) => keyframeQuery(url)),
    combine: (results) =>
      new Map(
        results.map((result, at): [string, KeyframeState] => [
          urls[at] ?? '',
          result.data !== undefined
            ? { kind: 'ready', index: result.data }
            : result.isError
              ? { kind: 'failed', message: errorMessageOf(result.error, '镜头读取失败') }
              : { kind: 'loading' },
        ]),
      ),
  })

const sourceDurationMs = (material: Material, keyframes: KeyframeStates): number | undefined => {
  const state = keyframes.get(material.url)
  if (state?.kind === 'ready') return Math.round(state.index.duration * 1000)
  return material.durationMs ?? undefined
}

/** 每条素材片用哪条字幕记录：识别完成的记录里最晚建的那条，与后端导出取的是同一条 */
const latestSubtitles = (jobs: readonly GenerationJob[]) => {
  const latest = new Map<string, GenerationJob>()
  for (const job of jobs.filter((item) => item.status === 'completed').toSorted(byCreation))
    if (job.sourceJobId != null) latest.set(job.sourceJobId, job)
  return latest
}

type ContextInput = {
  materials: Iterable<Material>
  keyframes: KeyframeStates
  subtitles: readonly GenerationJob[]
  music: readonly GenerationJob[]
  /** 音乐地址 → 量出的时长（毫秒）；记录上没记时长的音乐靠它 */
  musicDurations: ReadonlyMap<string, number>
  /** 当前用的这首音乐的拍点（音乐文件时间） */
  beats: { jobId: string; beats: MusicBeat[] } | undefined
}

/**
 * 编辑操作要的素材事实。只收时长已知的素材片与音乐；画面尺寸在加入成片时另给（见 `withSourceSize`）。
 */
export const buildEditContext = ({
  materials,
  keyframes,
  subtitles,
  music,
  musicDurations,
  beats,
}: ContextInput): EditContext => {
  const subtitleOf = latestSubtitles(subtitles)
  const sources: Record<string, SourceMedia> = {}
  for (const material of materials) {
    const durationMs = sourceDurationMs(material, keyframes)
    if (durationMs === undefined) continue
    const subtitle = subtitleOf.get(material.jobId)
    sources[material.jobId] = {
      durationMs,
      width: 0,
      height: 0,
      subtitle:
        subtitle === undefined
          ? null
          : { subtitleJobId: subtitle.id, sentences: subtitle.sentences ?? [] },
    }
  }
  const songs: EditContext['music'] = {}
  for (const job of music) {
    if (job.status !== 'completed' || job.outputUrl == null) continue
    const durationMs = job.durationMs ?? musicDurations.get(job.outputUrl)
    if (durationMs === undefined) continue
    songs[job.id] = { durationMs, beats: beats?.jobId === job.id ? beats.beats : [] }
  }
  return { sources, music: songs }
}

/** 加入成片时给这条素材补上画面尺寸（第一段视频定画布） */
export const withSourceSize = (
  context: EditContext,
  jobId: string,
  size: { width: number; height: number },
): EditContext => {
  const source = context.sources[jobId]
  return source === undefined
    ? context
    : { ...context, sources: { ...context.sources, [jobId]: { ...source, ...size } } }
}
