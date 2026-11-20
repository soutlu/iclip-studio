import { queryOptions, useQueries } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import { keyframeQuery } from '../editing/media-analysis'
import { keyframeRanges, type KeyframeIndex } from '../editing/keyframe-segments'
import type { Canvas } from './composition/film'
import type { MediaSpan } from './materials'

const loadReader = () => import('../editing/media-file')

/** 这个地址的视频有没有音轨。读不出来时查询失败，当作不知道。 */
export const videoAudioQuery = (url: string) =>
  queryOptions({
    queryKey: ['whole-film', 'video-audio', url],
    queryFn: async () => {
      const input = (await loadReader()).openInput(url)
      try {
        return (await input.getPrimaryAudioTrack()) !== null
      } finally {
        input.dispose()
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

/** 这个地址的视频画面的宽高；没有画面、宽高不是正数时是 null，读不出来时查询失败。 */
export const videoSizeQuery = (url: string) =>
  queryOptions({
    queryKey: ['whole-film', 'video-size', url],
    queryFn: async (): Promise<Canvas | null> => {
      const input = (await loadReader()).openInput(url)
      try {
        const track = await input.getPrimaryVideoTrack()
        if (track === null) return null
        const size = {
          width: await track.getDisplayWidth(),
          height: await track.getDisplayHeight(),
        }
        return size.width > 0 && size.height > 0 ? size : null
      } finally {
        input.dispose()
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

/** 几条视频各自有没有音轨：读出来的才在表里，还在读、读不出来的不在。 */
export const useVideoAudio = (urls: readonly string[]): ReadonlyMap<string, boolean> =>
  useQueries({
    queries: urls.map((url) => videoAudioQuery(url)),
    combine: (results) =>
      new Map(
        results.flatMap((result, at): [string, boolean][] =>
          result.data === undefined ? [] : [[urls[at] ?? '', result.data]],
        ),
      ),
  })

export type KeyframeState =
  | { kind: 'loading' }
  | { kind: 'ready'; index: KeyframeIndex }
  | { kind: 'failed'; message: string }

export type KeyframeStates = ReadonlyMap<string, KeyframeState>

/** 原作的总长（毫秒），镜头读好了才有。 */
export const takeDurationMs = (state: KeyframeState | undefined): number | undefined =>
  state?.kind === 'ready' ? Math.round(state.index.duration * 1000) : undefined

/** 原作的各个镜头（毫秒），镜头读好了才有。 */
export const takeShots = (state: KeyframeState | undefined): MediaSpan[] =>
  state?.kind === 'ready'
    ? keyframeRanges(state.index).map((shot) => ({
        startMs: Math.round(shot.start * 1000),
        endMs: Math.round(shot.end * 1000),
      }))
    : []

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
