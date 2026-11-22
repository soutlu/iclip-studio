import { useSyncExternalStore } from 'react'

/**
 * 播放头的实时时刻（毫秒）：播放时每帧写一次。播放头竖线、时间读数、进度条各自订阅它，只重画自己，
 * 不带着整个编辑器和时间线跟着每帧重画。每个编辑器实例建自己的一个。
 */
export type PlayheadClock = {
  readonly get: () => number
  /** 换成 `ms`；和现在一样时不通知订阅的组件。 */
  readonly set: (ms: number) => void
  /** 订阅变化，答复取消订阅的函数。 */
  readonly subscribe: (listener: () => void) => () => void
}

export const createPlayheadClock = (): PlayheadClock => {
  let now = 0
  const listeners = new Set<() => void>()
  return {
    get: () => now,
    set: (ms) => {
      if (ms === now) return
      now = ms
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** `clock` 现在的时刻（毫秒），变了就让调用它的组件重画。 */
export const usePlayheadClock = (clock: PlayheadClock) =>
  useSyncExternalStore(clock.subscribe, clock.get)
