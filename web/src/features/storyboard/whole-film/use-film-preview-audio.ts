/** 原声和音乐先渲染成一条预览音轨。来源和渲染结果仅在使用时缓存，改动取消旧 worker，关闭释放 PCM。 */

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import type { PlaySegment } from '../video-editor/play-layout'
import type { FilmAudioMusic, FilmAudioSegment, FilmPcm } from './film-audio'
import type { GainPoint } from './film-music'
import { useMusicPlayback } from './use-music-playback'

export type PreviewAudioState =
  { kind: 'ready' } | { kind: 'loading' } | { kind: 'failed'; message: string; retry: () => void }

type Options = {
  segments: readonly PreviewAudioSegment[]
  music:
    | {
        url: string
        buffer: AudioBuffer
        start: number
        curve: readonly GainPoint[]
        volume: number
      }
    | undefined
  bodyStartSeconds: number
  bodyDuration: number
  playback: { playing: boolean; muted: boolean }
  clock: number
}

export type PreviewAudioSegment = PlaySegment & { volume?: number }

/** Worker 使用 structured clone，避免转移并清空仍被查询缓存/音乐轨使用的来源 PCM。 */
const renderMix = (
  segments: FilmAudioSegment[],
  music: FilmAudioMusic | null,
  signal: AbortSignal,
) =>
  new Promise<AudioBuffer | undefined>((resolve, reject) => {
    if (segments.every((segment) => segment.source === null) && music === null) {
      resolve(undefined)
      return
    }
    const worker = new Worker(new URL('./film-audio.worker.ts', import.meta.url), {
      type: 'module',
    })
    const stop = () => {
      worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      stop()
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('预览准备已取消', 'AbortError'),
      )
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }: MessageEvent<{ pcm?: FilmPcm; error?: string }>) => {
      stop()
      if (data.pcm === undefined) {
        reject(new Error(data.error ?? '预览混音失败'))
        return
      }
      const buffer = new OfflineAudioContext(2, 1, data.pcm.sampleRate).createBuffer(
        2,
        data.pcm.channels[0]?.length ?? 1,
        data.pcm.sampleRate,
      )
      data.pcm.channels.forEach((channel, index) => buffer.getChannelData(index).set(channel))
      resolve(buffer)
    }
    worker.onerror = () => {
      stop()
      reject(new Error('预览混音失败，请重试'))
    }
    if (signal.aborted) abort()
    else worker.postMessage({ segments, music })
  })

export function useFilmPreviewAudio({
  segments,
  music,
  bodyStartSeconds,
  bodyDuration,
  playback,
  clock,
}: Options): {
  state: PreviewAudioState
  prime: () => void
} {
  const queryClient = useQueryClient()
  const urls = [...new Set(segments.map((segment) => segment.mediaUrl))]
  const sources = useQueries({
    queries: urls.map((url) => ({
      queryKey: ['whole-film', 'preview-source', url],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await import('./film-audio-source')).readFilmAudioSource(url, signal),
      staleTime: Infinity,
      gcTime: 0,
      retry: false,
    })),
  })
  const ready = sources.every((source) => source.isSuccess)
  // 仅音量变化时继续播放上一份混音，Worker 完成后在当前播放头换入新声音。
  // 素材、起点、剪辑或自动曲线变化时必须等新混音，不能沿用时间线不同的声音。
  const contentKey = JSON.stringify({
    segments: segments.map(({ mediaUrl, start, end }) => ({ mediaUrl, start, end })),
    music: music === undefined ? null : { url: music.url, start: music.start, curve: music.curve },
    bodyStartSeconds,
    bodyDuration,
    sources: sources.map((source) => source.dataUpdatedAt),
  })
  const mix = useQuery({
    queryKey: [
      'whole-film',
      'preview-mix',
      contentKey,
      segments,
      music === undefined
        ? null
        : {
            url: music.url,
            start: music.start,
            curve: music.curve,
            volume: music.volume,
          },
      bodyStartSeconds,
      bodyDuration,
      sources.map((source) => source.dataUpdatedAt),
    ],
    queryFn: async ({ signal }) => {
      const { pcmOf } = await import('./film-audio-source')
      const mixed = await renderMix(
        segments.map((segment) => ({
          start: segment.start,
          end: segment.end,
          volume: segment.volume ?? 1,
          source:
            queryClient.getQueryData<FilmPcm | null>([
              'whole-film',
              'preview-source',
              segment.mediaUrl,
            ]) ?? null,
        })),
        music === undefined
          ? null
          : {
              source: pcmOf(music.buffer),
              start: music.start,
              curve: music.curve,
              volume: music.volume,
              bodyStart: bodyStartSeconds,
              bodyDuration,
            },
        signal,
      )
      // React Query 禁止 undefined；null 表示各来源都没有音轨，不需要 AudioContext。
      return mixed ?? null
    },
    enabled: ready && segments.length > 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === contentKey ? previous : undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
  const failed = sources.find((source) => source.isError)
  const state: PreviewAudioState =
    failed !== undefined
      ? {
          kind: 'failed',
          message: errorMessageOf(failed.error, '预览原声读取失败'),
          retry: () => void failed.refetch(),
        }
      : mix.isError
        ? {
            kind: 'failed',
            message: errorMessageOf(mix.error, '预览混音失败'),
            retry: () => void mix.refetch(),
          }
        : segments.length === 0 || (ready && mix.isSuccess)
          ? { kind: 'ready' }
          : { kind: 'loading' }
  const { prime } = useMusicPlayback({
    buffer: state.kind === 'ready' ? (mix.data ?? undefined) : undefined,
    total: segments.reduce((sum, segment) => sum + segment.end - segment.start, 0),
    playing: playback.playing,
    muted: playback.muted,
    clock,
  })
  return { state, prime }
}
