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

// 读波形要下载整个文件，同一时间只读一个。
let peaksTurn: Promise<unknown> = Promise.resolve()

const readPeaksInTurn = (url: string) => {
  const read = peaksTurn.then(async () => (await loadReader()).readAudioPeaks(url))
  peaksTurn = read.catch(() => undefined)
  return read
}

export const useAudioPeaks = (
  urls: readonly string[],
  { enabled = true }: { enabled?: boolean } = {},
): ReadonlyMap<string, PeaksState> =>
  useQueries({
    queries: urls.map((url) => ({
      queryKey: ['video-editor', 'audio-peaks', url],
      queryFn: () => readPeaksInTurn(url),
      enabled,
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
