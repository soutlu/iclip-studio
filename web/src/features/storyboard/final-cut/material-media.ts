import { queryOptions, useQueries } from '@tanstack/react-query'
import { errorMessageOf } from '@/shared/api/client'
import { keyframeQuery } from '../editing/media-analysis'
import { keyframeRanges, type KeyframeIndex } from '../editing/keyframe-segments'
import type { Canvas } from './composition/film'
import type { MediaSpan } from './materials'

const loadReader = () => import('../editing/media-file')

/** 检测指定视频 URL 是否包含音轨；解析失败时查询报错，视为音轨状态未知。 */
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

/** 读取指定视频 URL 的显示宽高；无视频轨或宽高非正数时返回 `null`，解析失败时查询报错。 */
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

/** 批量查询视频是否包含音轨：仅将已成功解析的 URL 写入结果映射，加载中或失败项省略。 */
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

/** 获取原作总时长（毫秒），关键帧索引就绪后可用。 */
export const takeDurationMs = (state: KeyframeState | undefined): number | undefined =>
  state?.kind === 'ready' ? Math.round(state.index.duration * 1000) : undefined

/** 获取原作的分镜镜头区间列表（毫秒），关键帧索引就绪后可用。 */
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
