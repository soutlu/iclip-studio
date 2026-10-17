import { useQueries } from '@tanstack/react-query'
import { keyframeQuery } from '../editing/media-analysis'
import type { KeyframeIndex } from '../editing/keyframe-segments'

export type KeyframesState =
  | { kind: 'loading' }
  | { kind: 'ready'; index: KeyframeIndex }
  | { kind: 'failed'; error: unknown; retry: () => void }

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
