/** 时间线要读的文件信息：成片的关键帧表、各段来源的原声波形。读文件的模块连同 mediabunny 只在
 * 编辑器里用到时才加载；结果按地址留在内存里，同一条视频整个会话只读一遍。 */

import { queryOptions, skipToken, useQueries, useQuery } from '@tanstack/react-query'
import type { AudioPeaks, KeyframeIndex } from './reference-clip'

const loadReader = () => import('./reference-clip')

/** 地址对应的文件内容不会变：读到就一直用，读不出也不自动重试，错误立刻给到界面。 */
const KEEP = { staleTime: Infinity, gcTime: Infinity, retry: false } as const

/** 一版成片的关键帧表与时长；没有地址时不读。 */
const keyframeQuery = (url: string | undefined) =>
  queryOptions({
    queryKey: ['video-editor', 'keyframes', url],
    queryFn: url === undefined ? skipToken : async () => (await loadReader()).readKeyframes(url),
    ...KEEP,
  })

export const useKeyframes = (url: string | undefined) => useQuery(keyframeQuery(url))

export type KeyframesState =
  | { kind: 'loading' }
  | { kind: 'ready'; index: KeyframeIndex }
  | { kind: 'failed'; error: unknown; retry: () => void }

/** 整片素材轨共用单视频编辑器的关键帧索引缓存；只读取当前展示的版本。 */
export const useKeyframeIndexes = (urls: readonly string[]): ReadonlyMap<string, KeyframesState> =>
  useQueries({
    queries: urls.map(keyframeQuery),
    combine: (results) =>
      new Map(
        results.map((result, at): [string, KeyframesState] => [
          urls[at] ?? '',
          result.isError
            ? { kind: 'failed', error: result.error, retry: () => void result.refetch() }
            : result.data === undefined
              ? { kind: 'loading' }
              : { kind: 'ready', index: result.data },
        ]),
      ),
  })

/** 一条来源的原声：还在读、无声（没有音轨）、波形，或读不出来。 */
export type PeaksState =
  | { kind: 'loading' }
  | { kind: 'silent' }
  | { kind: 'ready'; peaks: AudioPeaks }
  | { kind: 'failed'; error: unknown }

/** 各来源的原声波形，按地址给。 */
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
