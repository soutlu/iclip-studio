import { useEffect, useState, useSyncExternalStore } from 'react'
import { AuditionPlayer, type AuditionProgress, type AuditionSpan } from './audition-player'

type AuditionOptions = {
  /** 试听所在的地方是不是正显示着；被藏起来（没有卸掉）时停下。 */
  active: boolean
  /** 放不出来时调。 */
  onError: () => void
}

/**
 * 音频试听：同一时间只放一条，所有条目共用一个播放器。
 * - `current`：当前这条的编号（在放或暂停着），`playing`：正在出声的那条（暂停、放完、放不出来时是 null）。
 * - `toggle`：没放过的从头放，是当前这条就暂停或续放；给了 `span` 时只放音频里的那一段（见 `AuditionSpan`）；`seek` 跳到总时长的某个比例处（读不到时长时按
 *   `fallbackMs` 算）；`retry` 放不出来时重来；
 *   `stop` 停下并清掉 `current`。
 * - 组件卸掉、`active` 变成假时都停下。播放进度用 `useAuditionProgress` 单独订阅，不让整个列表跟着每帧重画。
 */
export function useAudition({ active, onError }: AuditionOptions) {
  const [player] = useState(() => new AuditionPlayer())
  const { current, paused } = useSyncExternalStore(player.subscribe, player.getState)
  useEffect(() => () => player.stop(), [player])
  useEffect(() => {
    if (!active) player.stop()
  }, [active, player])

  return {
    current: current?.id ?? null,
    playing: current !== null && !paused ? current.id : null,
    toggle: (id: string, url: string, span?: AuditionSpan) =>
      player.toggle(id, url, onError, span ?? null),
    seek: (ratio: number, fallbackMs?: number) => player.seek(ratio, fallbackMs),
    retry: () => player.retry(onError),
    stop: () => player.stop(),
    player,
  }
}

export type Audition = ReturnType<typeof useAudition>

/** 订阅当前这条的播放进度（放着时每帧更新）：只在进度条、试听条和正在放的那一行里用。 */
export function useAuditionProgress(audition: Audition): AuditionProgress {
  const { player } = audition
  return useSyncExternalStore(player.subscribe, player.getProgress)
}
