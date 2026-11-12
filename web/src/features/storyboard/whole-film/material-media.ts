import { queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { keyframeQuery } from '../editing/media-analysis'
import type { KeyframeIndex } from '../editing/keyframe-segments'

const loadReader = () => import('../editing/media-file')

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
