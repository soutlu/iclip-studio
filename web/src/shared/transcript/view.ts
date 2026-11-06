import { ApiError } from '@/shared/api/client'
import type { ChannelData } from './channel'

export interface TranscriptView extends ChannelData {
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
  tasks: new Map(),
  title: '',
}

export const LOADING_VIEW: TranscriptView = { ...EMPTY_DATA, status: 'loading' }

export const NO_SESSION_VIEW: TranscriptView = { ...EMPTY_DATA, status: 'ready' }

export const errorView = (error: string): TranscriptView => ({
  ...EMPTY_DATA,
  error,
  status: 'error',
})

export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)

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

export const backoffMs = (attempt: number): number => Math.min(attempt * 2000, 15_000)
