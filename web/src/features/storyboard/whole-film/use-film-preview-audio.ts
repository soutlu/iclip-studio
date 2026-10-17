import { useQueries, useQuery } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import type { PlaySegment } from '../editing/play-layout'
import type { FilmAudioMusic, FilmAudioSegment, FilmPcm } from './film-audio'
import type { GainPoint } from './film-music'
import { useMusicPlayback } from './use-music-playback'

export type PreviewAudioState =
  { kind: 'ready' } | { kind: 'loading' } | { kind: 'failed'; message: string; retry: () => void }

export type PreviewAudioSegment = PlaySegment & { volume?: number }

export type PreviewMusic = {
  url: string
  buffer: AudioBuffer
  start: number
  curve: readonly GainPoint[]
  volume: number
}

type Options = {
  segments: readonly PreviewAudioSegment[]
  music: PreviewMusic | undefined
  waiting: boolean
  bodyStartSeconds: number
  bodyDuration: number
  playback: { playing: boolean; muted: boolean }
  clock: number
}

// Worker 消息用结构化克隆而不转移来源 PCM：查询缓存与音乐轨还在用它们。
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
  waiting,
  bodyStartSeconds,
  bodyDuration,
  playback,
  clock,
}: Options): { state: PreviewAudioState; prime: () => void } {
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
  const sourcePcm = new Map(urls.map((url, index) => [url, sources[index]?.data ?? null]))
  const ready = sources.every((source) => source.isSuccess)
  const contentKey = JSON.stringify({
    segments: segments.map(({ mediaUrl, start, end }) => ({ mediaUrl, start, end })),
    music: music === undefined ? null : { url: music.url, start: music.start, curve: music.curve },
    bodyStartSeconds,
    bodyDuration,
    sources: sources.map((source) => source.dataUpdatedAt),
  })
  const volumes = {
    segments: segments.map((segment) => segment.volume ?? 1),
    music: music?.volume ?? null,
  }
  const mixCurrent = async (signal: AbortSignal) => {
    const { pcmOf } = await import('./film-audio-source')
    const buffer = await renderMix(
      segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        volume: segment.volume ?? 1,
        source: sourcePcm.get(segment.mediaUrl) ?? null,
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
    return { contentKey, buffer: buffer ?? null }
  }
  const mix = useQuery({
    queryKey: ['whole-film', 'preview-mix', contentKey, volumes],
    queryFn: ({ signal }) => mixCurrent(signal),
    enabled: ready && segments.length > 0,
    placeholderData: (previous) => (previous?.contentKey === contentKey ? previous : undefined),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
  const failed = sources.find((source) => source.isError)
  const mixState: PreviewAudioState =
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
    buffer: mixState.kind === 'ready' ? (mix.data?.buffer ?? undefined) : undefined,
    duration: segments.reduce((sum, segment) => sum + segment.end - segment.start, 0),
    playing: playback.playing,
    muted: playback.muted,
    clock,
  })
  return { state: waiting ? { kind: 'loading' } : mixState, prime }
}
