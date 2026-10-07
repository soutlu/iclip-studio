/** 界面看到的一条流：通道的数据加上池给的加载状态；同一版内引用不变，供 useSyncExternalStore 比较。 */

import { ApiError } from '@/shared/api/client'
import type { ChannelData } from './channel'

export interface TranscriptView extends ChannelData {
  /** loading 表示等待基线；读取失败或对话已不可见时为 error。 */
  status: 'loading' | 'ready' | 'error'
  error?: string
}

const EMPTY_DATA: ChannelData = {
  activity: 'unknown',
  contextTokens: undefined,
  deletedAt: null,
  forkTurn: null,
  forkedFrom: null,
  hasMoreOlder: false,
  interactions: new Map(),
  items: [],
  loadOlderError: false,
  loadingOlder: false,
  maxContextTokens: undefined,
  ownerUserId: null,
  pendingInteractions: [],
  prompts: [],
  title: '',
}

export const LOADING_VIEW: TranscriptView = { ...EMPTY_DATA, status: 'loading' }

export const errorView = (error: string): TranscriptView => ({
  ...EMPTY_DATA,
  error,
  status: 'error',
})

/** 对话不存在、或当前主体看不见：两者一个待遇，不重试。 */
export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)

/**
 * 照 Kimi 主会话池：一帧之内的多次变化合成一次通知，用 requestAnimationFrame，另加 50ms 兜底定时器
 * （页面在后台时 rAF 不跑）。flush 也可以立即调用，例如基线刚落地时。
 */
export class BatchedNotifier {
  private frame: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly beforeFlush: () => void

  constructor(beforeFlush: () => void) {
    this.beforeFlush = beforeFlush
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  schedule(): void {
    if (this.frame !== null || this.timer !== null) return
    if (typeof requestAnimationFrame === 'function') {
      this.frame = requestAnimationFrame(() => this.flush())
    }
    this.timer = setTimeout(() => this.flush(), 50)
  }

  flush(): void {
    if (this.frame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.beforeFlush()
    for (const listener of this.listeners) listener()
  }

  cancel(): void {
    if (this.frame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frame)
    }
    if (this.timer !== null) clearTimeout(this.timer)
    this.frame = null
    this.timer = null
  }
}

/** 空 reset 后第 n 次重读的等待（Kimi：n×2 秒，上限 15 秒）；基线失败的重试同一口径。 */
export const backoffMs = (attempt: number): number => Math.min(attempt * 2000, 15_000)
