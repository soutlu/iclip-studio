import { useSyncExternalStore } from 'react'

/**
 * 播放头实时时刻源（毫秒）：播放期间逐帧更新。播放头竖线、时间读数与进度条独立订阅此状态，
 * 实现局部重绘而不触发整个编辑器与时间线逐帧重渲染。每个编辑器实例持有独立实例。
 */
export type PlayheadClock = {
  readonly get: () => number
  /** 更新为 `ms`；与当前值相同时不通知订阅方。 */
  readonly set: (ms: number) => void
  /** 订阅时刻变化，返回取消订阅函数。 */
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

/** 读取 `clock` 当前时刻（毫秒），并在数值变化时触发调用组件重绘。 */
export const usePlayheadClock = (clock: PlayheadClock) =>
  useSyncExternalStore(clock.subscribe, clock.get)
