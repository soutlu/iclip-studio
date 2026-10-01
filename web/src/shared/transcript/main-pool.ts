/**
 * 主会话流的读取池，照 Kimi 的 TFe：先读基线、再带水位订阅；断档时重读基线再重订；常驻最近几段，切回来不用重读。
 *
 * 与 Kimi 的不同只有两处，都是环境所需：
 * - 同一段对话可以被多个界面同时用（对话页与工作台），所以按对话记持有数；有人在用的不淘汰。
 * - 水位带 epoch（ADR-0004），订阅与续订把它一起带上。
 */

import { errorMessageOf } from '@/shared/api/client'
import { TranscriptChannel } from './channel'
import { MAIN_AGENT_ID, type TranscriptConnection, type TranscriptOps } from './connection'
import type { LocalPromptStore, LocalTimeline } from './local-prompts'
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

/** 常驻对话数（Kimi IFe）。 */
const MAX_RESIDENT = 4

/** 主会话首屏轮数（Kimi 主池覆盖为 10，通用默认 20）。 */
const MAIN_PAGE_SIZE = 10

/** refresh 前后本地发送状态还在变时，最多重读几次（Kimi 同为 3）。 */
const MAX_REFRESH_PASSES = 3

const GONE_MESSAGE = '这段对话不存在，或者不是你的'

interface PendingReset {
  snapshot: AgentTranscriptSnapshot
  seq: number | undefined
  epoch: string
}

interface Entry {
  conversationId: string
  channel: TranscriptChannel
  baselineLoaded: boolean
  resumePromise: Promise<void> | null
  gapRetryPending: boolean
  pendingReset: PendingReset | null
  opsAfterReset: { ops: TranscriptOps; seq: number | undefined; epoch: string }[]
  emptyResetRetries: number
  lastTouchedSeq: number
  view: TranscriptView
}

interface BaselineRetry {
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
}

export interface MainPoolOptions {
  connection: TranscriptConnection
  localPrompts: LocalPromptStore
  maxResident?: number
}

export class MainTranscriptPool {
  private readonly connection: TranscriptConnection
  private readonly localPrompts: LocalPromptStore
  private readonly maxResident: number
  private readonly entries = new Map<string, Entry>()
  /** 已在连接上订阅主流的对话。 */
  private readonly subscribed = new Set<string>()
  /** 基线从没读到过时的退避重试，按对话记。 */
  private readonly retries = new Map<string, BaselineRetry>()
  /** 没人在用的对话（Kimi 的 deactivated 集合）。 */
  private readonly inactive = new Set<string>()
  /** 正在用这段对话的界面数；Kimi 只有一个当前会话，我们的对话页与工作台会同时用。 */
  private readonly holders = new Map<string, number>()
  /** 基线读不到或对话不可见时给界面的话；读到基线即清掉。 */
  private readonly failures = new Map<string, TranscriptView>()
  private readonly dirty = new Set<Entry>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly notifier: BatchedNotifier
  private touch = 0

  constructor(options: MainPoolOptions) {
    this.connection = options.connection
    this.localPrompts = options.localPrompts
    this.maxResident = options.maxResident ?? MAX_RESIDENT
    this.notifier = new BatchedNotifier(() => this.refreshViews())
  }

  readonly subscribe = (listener: () => void): (() => void) => this.notifier.subscribe(listener)

  /** 同一版内返回同一个对象。 */
  view(conversationId: string): TranscriptView {
    const entry = this.entries.get(conversationId)
    const failure = this.failures.get(conversationId)
    if (entry === undefined) return failure ?? LOADING_VIEW
    if (!entry.baselineLoaded && failure !== undefined) return failure
    return entry.view
  }

  /** 开始用一段对话；返回的释放函数只算一次。 */
  activate(conversationId: string): () => void {
    this.clearRetry(conversationId)
    this.inactive.delete(conversationId)
    this.holders.set(conversationId, (this.holders.get(conversationId) ?? 0) + 1)
    const entry = this.entryOf(conversationId)
    this.touch += 1
    entry.lastTouchedSeq = this.touch
    if (entry.baselineLoaded) this.subscribeMain(conversationId, entry)
    else void this.resume(entry)
    this.trim()
    let released = false
    return () => {
      if (released) return
      released = true
      this.deactivate(conversationId)
    }
  }

  /** 界面上的「重新加载」与「读不到时重试」。 */
  refresh(conversationId: string): void {
    this.clearRetry(conversationId)
    this.failures.delete(conversationId)
    void this.resume(this.entryOf(conversationId))
    this.notifier.schedule()
  }

  /** 读更早的一页；失败由通道记下，界面据此给重试。 */
  loadOlder(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId)
    return entry === undefined ? Promise.resolve() : entry.channel.loadOlder()
  }

  /** Provider 卸载时调用：停掉所有定时器，不再触发读取。 */
  close(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const retry of this.retries.values()) if (retry.timer !== null) clearTimeout(retry.timer)
    this.retries.clear()
    this.notifier.cancel()
  }

  private deactivate(conversationId: string): void {
    this.clearRetry(conversationId)
    const held = Math.max(0, (this.holders.get(conversationId) ?? 0) - 1)
    if (held === 0) {
      this.holders.delete(conversationId)
      this.inactive.add(conversationId)
    } else {
      this.holders.set(conversationId, held)
    }
    this.trim()
  }

  private entryOf(conversationId: string): Entry {
    const found = this.entries.get(conversationId)
    if (found !== undefined) return found
    const entry: Entry = {
      baselineLoaded: false,
      channel: new TranscriptChannel({
        agentId: MAIN_AGENT_ID,
        fetchPage: (request) => fetchTranscriptPage(conversationId, MAIN_AGENT_ID, request),
        onChange: () => this.changed(entry),
        onGap: () => {
          if (entry.resumePromise !== null) {
            entry.gapRetryPending = true
            return
          }
          void this.resume(entry)
        },
        pageSize: MAIN_PAGE_SIZE,
      }),
      conversationId,
      emptyResetRetries: 0,
      gapRetryPending: false,
      lastTouchedSeq: 0,
      opsAfterReset: [],
      pendingReset: null,
      resumePromise: null,
      view: LOADING_VIEW,
    }
    this.entries.set(conversationId, entry)
    return entry
  }

  private subscribeMain(conversationId: string, entry?: Entry): void {
    this.connection.subscribe(
      conversationId,
      {
        onNotFound: () => this.gone(conversationId),
        onOps: (_agentId, ops, seq, epoch) => this.applyOps(conversationId, ops, seq, epoch),
        onReset: (_agentId, snapshot, seq, epoch) =>
          this.receiveReset(conversationId, snapshot, seq, epoch),
      },
      'delta',
      MAIN_AGENT_ID,
      entry?.channel.watermark,
    )
    this.subscribed.add(conversationId)
  }

  private resume(entry: Entry): Promise<void> {
    if (entry.resumePromise !== null) return entry.resumePromise
    const task = this.recover(entry).finally(() => {
      if (entry.resumePromise !== task) return
      entry.resumePromise = null
      this.handOffReset(entry)
      if (entry.gapRetryPending) {
        entry.gapRetryPending = false
        void this.resume(entry)
      }
    })
    entry.resumePromise = task
    return task
  }

  /** 重读基线再带水位重订（Kimi 的 b）。 */
  private async recover(entry: Entry): Promise<void> {
    const { conversationId } = entry
    try {
      if (entry.channel.loadingOlder) await entry.channel.settleOlder().catch(() => {})
      for (let pass = 0; pass < MAX_REFRESH_PASSES; pass += 1) {
        const before = this.localPrompts.getLocalTurnState(conversationId)
        await entry.channel.refresh()
        const after = this.localPrompts.getLocalTurnState(conversationId)
        if (before.generation === after.generation && before.pending === after.pending) break
      }
      entry.baselineLoaded = true
      entry.emptyResetRetries = 0
      this.failures.delete(conversationId)
      this.changed(entry)
      this.notifier.flush()
      if (this.entries.get(conversationId) === entry) {
        this.clearRetry(conversationId)
        this.subscribeMain(conversationId, entry)
      }
    } catch (error) {
      if (isGone(error)) {
        this.gone(conversationId)
        return
      }
      if (entry.baselineLoaded) {
        // 已经有内容：不带水位重订，服务端回 reset，空 reset 再走退避重读。
        if (this.entries.get(conversationId) === entry) this.subscribeMain(conversationId)
        return
      }
      if (this.entries.get(conversationId) !== entry) return
      this.entries.delete(conversationId)
      this.dirty.delete(entry)
      const message = errorMessageOf(error, '读取对话内容失败')
      this.failures.set(conversationId, errorView(message))
      if (this.inactive.has(conversationId)) {
        this.notifier.schedule()
        return
      }
      const retry = this.retries.get(conversationId) ?? { attempt: 0, timer: null }
      retry.attempt += 1
      this.retries.set(conversationId, retry)
      retry.timer = setTimeout(() => {
        retry.timer = null
        if (this.retries.get(conversationId) !== retry || this.entries.has(conversationId)) return
        void this.resume(this.entryOf(conversationId))
      }, backoffMs(retry.attempt))
      this.notifier.schedule()
    }
  }

  /** 读取在途时攒下的 reset，读完再落地，随后回放它之后的批次。 */
  private handOffReset(entry: Entry): void {
    const pending = entry.pendingReset
    entry.pendingReset = null
    if (pending === null || this.entries.get(entry.conversationId) !== entry) return
    entry.channel.receiveReset(pending.snapshot, pending.seq, pending.epoch)
    entry.baselineLoaded = true
    this.clearRetry(entry.conversationId)
    this.subscribeMain(entry.conversationId, entry)
    const after = entry.opsAfterReset
    entry.opsAfterReset = []
    for (const batch of after) entry.channel.applyOps(batch.ops, batch.seq, batch.epoch)
  }

  private receiveReset(
    conversationId: string,
    snapshot: AgentTranscriptSnapshot,
    seq: number | undefined,
    epoch: string,
  ): void {
    const entry = this.entries.get(conversationId)
    if (entry === undefined) return
    if (snapshot.items.length === 0) {
      // 我们的 reset 不带历史轮：不拿它替换内容，按 Kimi 的退避重读基线。
      entry.emptyResetRetries += 1
      this.later(() => {
        if (this.entries.get(conversationId) === entry) void this.resume(entry)
      }, backoffMs(entry.emptyResetRetries))
      return
    }
    if (entry.resumePromise !== null) {
      if (entry.pendingReset !== null) entry.opsAfterReset = []
      entry.pendingReset = { epoch, seq, snapshot }
      return
    }
    if (entry.channel.loadingOlder) {
      if (entry.pendingReset !== null) entry.opsAfterReset = []
      entry.pendingReset = { epoch, seq, snapshot }
      void entry.channel
        .settleOlder()
        .catch(() => {})
        .then(() => {
          if (entry.resumePromise === null) this.handOffReset(entry)
        })
      return
    }
    entry.channel.receiveReset(snapshot, seq, epoch)
    entry.baselineLoaded = true
    this.clearRetry(conversationId)
  }

  private applyOps(
    conversationId: string,
    ops: TranscriptOps,
    seq: number | undefined,
    epoch: string,
  ): boolean {
    const entry = this.entries.get(conversationId)
    if (entry === undefined) return true
    if (entry.pendingReset !== null) {
      entry.opsAfterReset.push({ epoch, ops, seq })
      return true
    }
    return entry.channel.applyOps(ops, seq, epoch)
  }

  /**
   * 超出常驻数时淘汰最久没碰的；有人在用、正在重读基线、或本地还有没被接替的发送的不淘汰。
   * 「正在重读」是我们加的：持有数一归零就可能触发淘汰（如严格模式的挂载、卸载、再挂载），不能丢下在途的那次读取。
   */
  private trim(): void {
    if (this.entries.size <= this.maxResident) return
    const candidates = [...this.entries.values()]
      .sort((left, right) => right.lastTouchedSeq - left.lastTouchedSeq)
      .filter(
        (entry) =>
          (this.holders.get(entry.conversationId) ?? 0) === 0 &&
          entry.resumePromise === null &&
          !this.hasPendingLocalWork(entry),
      )
    for (const entry of candidates.slice(this.maxResident)) this.evict(entry)
  }

  private evict(entry: Entry): void {
    const { conversationId } = entry
    this.entries.delete(conversationId)
    this.dirty.delete(entry)
    if (this.subscribed.delete(conversationId)) {
      this.connection.unsubscribe(conversationId, MAIN_AGENT_ID)
    }
  }

  private hasPendingLocalWork(entry: Entry): boolean {
    const data = entry.channel.data()
    const timeline: LocalTimeline = {
      prompts: data.prompts,
      turnActive: data.activity === 'turn',
      turns: entry.channel.turns(),
    }
    return this.localPrompts.hasPendingLocalWork(entry.conversationId, timeline)
  }

  /** 对话不存在或看不见：停在错误态，不再重试，界面可以手动重试。 */
  private gone(conversationId: string): void {
    this.clearRetry(conversationId)
    const entry = this.entries.get(conversationId)
    if (entry !== undefined) {
      this.entries.delete(conversationId)
      this.dirty.delete(entry)
    }
    if (this.subscribed.delete(conversationId)) {
      this.connection.unsubscribe(conversationId, MAIN_AGENT_ID)
    }
    this.failures.set(conversationId, errorView(GONE_MESSAGE))
    this.notifier.schedule()
  }

  private clearRetry(conversationId: string): void {
    const retry = this.retries.get(conversationId)
    if (retry?.timer != null) clearTimeout(retry.timer)
    this.retries.delete(conversationId)
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
