import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStableValue } from '../editing/use-stable-value'
import type { SourceLength } from './clip-edit'
import type { FilmClip } from './composition/film'
import { isBeatSource, type BeatGrid } from './music-beats'

// 比一首歌长得多的多半是口播或混好的整段声音，整个解出来很占内存，不算（照参照的工作台）
const LONGEST_SOURCE_MS = 15 * 60 * 1000

/**
 * 时间线上配乐（见 `isBeatSource`）的节拍，按音频地址。在后台一首一首地取（`read` 读存着的节拍或读声音来算），
 * 同一个地址只算一次；算的时候不挡操作。读不到声音、没有稳定的节拍的地址就没有节拍，不提示。
 * 素材长度（`sourceMs`）已知、超过 15 分钟的不算。
 */
export function useMusicBeats(
  clips: readonly FilmClip[],
  read: (src: string) => Promise<BeatGrid | null>,
  sourceMs: SourceLength,
): ReadonlyMap<string, BeatGrid> {
  const sources = useStableValue(
    [
      ...new Set(
        clips.flatMap((clip) =>
          isBeatSource(clip) && !((sourceMs(clip) ?? 0) > LONGEST_SOURCE_MS) ? [clip.src] : [],
        ),
      ),
    ].sort(),
  )
  const [grids, setGrids] = useState<ReadonlyMap<string, BeatGrid>>(() => new Map())
  const readRef = useRef(read)
  useLayoutEffect(() => {
    readRef.current = read
  })
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // 排过队的地址；一次只算一首，免得一打开就同时解好几首
  const queuedRef = useRef(new Set<string>())
  const queueRef = useRef(Promise.resolve())

  useEffect(() => {
    for (const src of sources) {
      if (queuedRef.current.has(src)) continue
      queuedRef.current.add(src)
      queueRef.current = queueRef.current.then(async () => {
        try {
          const grid = await readRef.current(src)
          if (grid !== null && mountedRef.current)
            setGrids((known) => new Map(known).set(src, grid))
        } catch (error) {
          console.error('final-cut 配乐节拍分析失败', error)
        }
      })
    }
  }, [sources])

  return grids
}
