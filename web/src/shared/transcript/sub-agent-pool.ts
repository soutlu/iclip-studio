import { errorMessageOf } from '@/shared/api/client'
import { TranscriptChannel } from './channel'
import type { TranscriptConnection, TranscriptOps } from './connection'
import { fetchTranscriptPage } from './transcript.api'
import type { AgentTranscriptSnapshot } from './vendor'
import {
  backoffMs,
  BatchedNotifier,
  errorView,
  isGone,
  LOADING_VIEW,
  type TranscriptView,
} from './view'

const MISSING_MESSAGE = '该子代理的对话加载失败'

interface Entry {
  conversationId: string
  agentId: string
  channel: TranscriptChannel
  baselineLoaded: boolean
  resumePromise: Promise<void> | null
  emptyResetRetries: number
  failure: TranscriptView | null
  view: TranscriptView
}

const keyOf = (conversationId: string, agentId: string) => `${conversationId}\u0000${agentId}`

export class SubAgentTranscriptPool {
  private readonly connection: TranscriptConnection
  private readonly entries = new Map<string, Entry>()
  private readonly desired = new Map<string, string>()
  private readonly subscribed = new Map<string, string>()
  private readonly holders = new Map<string, number>()
  private readonly dirty = new Set<Entry>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly notifier: BatchedNotifier

  constructor(connection: TranscriptConnection) {
    this.connection = connection
    this.notifier = new BatchedNotifier(() => this.refreshViews())
  }

  readonly subscribe = (listener: () => void): (() => void) => this.notifier.subscribe(listener)

  view(conversationId: string, agentId: string): TranscriptView {
    const entry = this.entries.get(keyOf(conversationId, agentId))
    if (entry === undefined) return LOADING_VIEW
    if (!entry.baselineLoaded && entry.failure !== null) return entry.failure
    return entry.view
  }

  activate(conversationId: string, agentId: string): () => void {
    const key = keyOf(conversationId, agentId)
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1)
    const previous = this.subscribed.get(conversationId)
    if (previous !== undefined && previous !== agentId) {
      this.connection.unsubscribe(conversationId, previous)
      this.subscribed.delete(conversationId)
    }
    this.desired.set(conversationId, agentId)
    const entry = this.entryOf(conversationId, agentId)
    if (entry.baselineLoaded) this.subscribeChild(entry, entry.channel.watermark !== undefined)
    else void this.resume(entry)
    let released = false
    return () => {
      if (released) return
      released = true
      this.deactivate(conversationId, agentId)
    }
  }

  refresh(conversationId: string, agentId: string): void {
    const entry = this.entryOf(conversationId, agentId)
    entry.failure = null
    void this.resume(entry)
    this.changed(entry)
  }

  loadOlder(conversationId: string, agentId: string): Promise<void> {
    const entry = this.entries.get(keyOf(conversationId, agentId))
    return entry === undefined ? Promise.resolve() : entry.channel.loadOlder()
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.notifier.cancel()
  }

  private deactivate(conversationId: string, agentId: string): void {
    const key = keyOf(conversationId, agentId)
    const held = Math.max(0, (this.holders.get(key) ?? 0) - 1)
    if (held > 0) {
      this.holders.set(key, held)
      return
    }
    this.holders.delete(key)
    if (this.desired.get(conversationId) !== agentId) return
    this.desired.delete(conversationId)
    if (this.subscribed.get(conversationId) === agentId) {
      this.connection.unsubscribe(conversationId, agentId)
      this.subscribed.delete(conversationId)
    }
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      this.entries.delete(key)
      this.dirty.delete(entry)
    }
  }

  private entryOf(conversationId: string, agentId: string): Entry {
    const key = keyOf(conversationId, agentId)
    const found = this.entries.get(key)
    if (found !== undefined) return found
    const entry: Entry = {
      agentId,
      baselineLoaded: false,
      channel: new TranscriptChannel({
        agentId,
        fetchPage: (request) => fetchTranscriptPage(conversationId, agentId, request),
        onChange: () => this.changed(entry),
        onGap: () => void this.resume(entry),
      }),
      conversationId,
      emptyResetRetries: 0,
      failure: null,
      resumePromise: null,
      view: LOADING_VIEW,
    }
    this.entries.set(key, entry)
    return entry
  }

  private current(entry: Entry): boolean {
    return (
      this.entries.get(keyOf(entry.conversationId, entry.agentId)) === entry &&
      this.desired.get(entry.conversationId) === entry.agentId
    )
  }

  private subscribeChild(entry: Entry, withWatermark: boolean): void {
    const { agentId, conversationId } = entry
    this.connection.subscribe(
      conversationId,
      {
        onNotFound: () => this.missing(entry),
        onOps: (_agentId, ops, seq, epoch) => this.applyOps(entry, ops, seq, epoch),
        onReset: (_agentId, snapshot, seq, epoch) => this.receiveReset(entry, snapshot, seq, epoch),
      },
      'delta',
      agentId,
      withWatermark ? entry.channel.watermark : undefined,
    )
    this.subscribed.set(conversationId, agentId)
  }

  private resume(entry: Entry): Promise<void> {
    if (entry.resumePromise !== null) return entry.resumePromise
    const task = this.recover(entry).finally(() => {
      if (entry.resumePromise === task) entry.resumePromise = null
    })
    entry.resumePromise = task
    return task
  }

  private async recover(entry: Entry): Promise<void> {
    try {
      await entry.channel.refresh()
      entry.baselineLoaded = true
      entry.emptyResetRetries = 0
      entry.failure = null
      this.changed(entry)
      this.notifier.flush()
      if (this.current(entry)) this.subscribeChild(entry, true)
    } catch (error) {
      if (isGone(error)) {
        this.missing(entry)
        return
      }
      if (!entry.baselineLoaded) {
        entry.failure = errorView(errorMessageOf(error, MISSING_MESSAGE))
        this.changed(entry)
      }
      if (this.current(entry)) this.subscribeChild(entry, false)
    }
  }

  private receiveReset(
    entry: Entry,
    snapshot: AgentTranscriptSnapshot,
    seq: number | undefined,
    epoch: string,
  ): void {
    if (!this.current(entry)) return
    if (snapshot.items.length === 0) {
      entry.emptyResetRetries += 1
      this.later(() => {
        if (this.current(entry)) void this.resume(entry)
      }, backoffMs(entry.emptyResetRetries))
      return
    }
    entry.channel.receiveReset(snapshot, seq, epoch)
    entry.baselineLoaded = true
  }

  private applyOps(
    entry: Entry,
    ops: TranscriptOps,
    seq: number | undefined,
    epoch: string,
  ): boolean {
    return this.current(entry) ? entry.channel.applyOps(ops, seq, epoch) : true
  }

  private missing(entry: Entry): void {
    entry.failure = errorView(MISSING_MESSAGE)
    entry.baselineLoaded = false
    if (this.subscribed.get(entry.conversationId) === entry.agentId) {
      this.subscribed.delete(entry.conversationId)
    }
    this.changed(entry)
  }

  private later(run: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, delay)
    this.timers.add(timer)
  }

  private changed(entry: Entry): void {
    this.dirty.add(entry)
    this.notifier.schedule()
  }

  private refreshViews(): void {
    for (const entry of this.dirty) {
      entry.view = {
        ...entry.channel.data(),
        status: entry.baselineLoaded ? 'ready' : 'loading',
      }
    }
    this.dirty.clear()
  }
}
