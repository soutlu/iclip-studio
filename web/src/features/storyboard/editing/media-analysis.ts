import { queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import type { AudioPeaks } from './audio-peaks'

const loadReader = () => import('./media-file')

const KEEP = { staleTime: Infinity, gcTime: Infinity, retry: false } as const

export const keyframeQuery = (url: string | undefined) =>
  queryOptions({
    queryKey: ['video-editor', 'keyframes', url],
    queryFn: url === undefined ? skipToken : async () => (await loadReader()).readKeyframes(url),
    ...KEEP,
  })

export const useKeyframes = (url: string | undefined) => useQuery(keyframeQuery(url))

export type PeaksState =
  | { kind: 'loading' }
  | { kind: 'silent' }
  | { kind: 'ready'; peaks: AudioPeaks }
  | { kind: 'failed'; error: unknown }

export const useAudioPeaks = (urls: readonly string[]): ReadonlyMap<string, PeaksState> =>
  useQueries({
    queries: urls.map((url) => ({
      queryKey: ['video-editor', 'audio-peaks', url],
      queryFn: async () => (await loadReader()).readAudioPeaks(url),
      ...KEEP,
    })),
    combine: (results) =>
      new Map(
        results.map((result, at): [string, PeaksState] => [
          urls[at] ?? '',
          result.isError
            ? { kind: 'failed', error: result.error }
            : result.data === undefined
              ? { kind: 'loading' }
              : result.data === null
                ? { kind: 'silent' }
                : { kind: 'ready', peaks: result.data },
        ]),
      ),
  })
