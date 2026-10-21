import { queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import { audioBufferPeaks, type AudioPeaks } from '../editing/audio-peaks'
import type { MusicBeat } from './editing/context'

const DECODE_RATE = 44_100

export type MusicAnalysis = { durationMs: number; peaks: AudioPeaks }

/** 下载并解码一首音乐，量出时长与波形。音乐在对象存储上，是外链素材，不经 apiFetch。 */
const analyzeMusic = async (url: string, signal: AbortSignal): Promise<MusicAnalysis> => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`音乐下载失败：${response.status}`)
  // 离线上下文不受浏览器「先有用户手势才能出声」的限制。
  const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(
    await response.arrayBuffer(),
  )
  return { durationMs: Math.round(buffer.duration * 1000), peaks: audioBufferPeaks(buffer) }
}

const musicAnalysisQuery = (url: string | undefined) =>
  queryOptions({
    queryKey: ['whole-film', 'music-analysis', url],
    queryFn: url === undefined ? skipToken : ({ signal }) => analyzeMusic(url, signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

export const useMusicAnalysis = (url: string | undefined) => useQuery(musicAnalysisQuery(url))

/** 记录上没记时长的几首音乐，量出来的时长（地址 → 毫秒）；与列表里的波形共用同一份分析 */
export const useMeasuredMusicDurations = (urls: readonly string[]): ReadonlyMap<string, number> =>
  useQueries({
    queries: urls.map((url) => musicAnalysisQuery(url)),
    combine: (results) =>
      new Map(
        results.flatMap((result, at) => {
          const url = urls[at]
          return url === undefined || result.data === undefined
            ? []
            : [[url, result.data.durationMs] as const]
        }),
      ),
  })

export type MusicBeats =
  | { kind: 'ready'; beats: MusicBeat[] }
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }

const NO_STEADY_BEAT = '这首音乐没有稳定的节拍，无法自动卡点'

/** 下载、解码一首音乐，用 HyperFrames 的拍点分析（与 Studio 同一套）找出拍点 */
const analyzeBeats = async (url: string, signal: AbortSignal): Promise<MusicBeat[]> => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`音乐下载失败：${response.status}`)
  const buffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(
    await response.arrayBuffer(),
  )
  const { analyzeMusicFromBuffer } = await import('@hyperframes/core/beats')
  const analysis = await analyzeMusicFromBuffer(buffer)
  if (analysis.bpm === null) return []
  return analysis.beatTimes.map((time, index) => ({
    timeMs: Math.round(time * 1000),
    strength: analysis.beatStrengths[index] ?? 0,
  }))
}

const musicBeatsQuery = (url: string | undefined) =>
  queryOptions({
    queryKey: ['whole-film', 'music-beats', url],
    queryFn: url === undefined ? skipToken : ({ signal }) => analyzeBeats(url, signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

/**
 * 成片在用的这首音乐的拍点（音乐文件时间）；每首只分析一次。还在分析、分析失败或没有稳定节拍时
 * 「自动卡点」按给出的原因置灰。
 */
export const useMusicBeats = (url: string | undefined): MusicBeats => {
  const query = useQuery(musicBeatsQuery(url))
  if (url === undefined) return { kind: 'unavailable', reason: '还没有选用音乐，无法自动卡点' }
  if (query.isError) return { kind: 'unavailable', reason: '拍点分析失败，无法自动卡点' }
  if (query.data === undefined) return { kind: 'loading' }
  return query.data.length === 0
    ? { kind: 'unavailable', reason: NO_STEADY_BEAT }
    : { kind: 'ready', beats: query.data }
}
