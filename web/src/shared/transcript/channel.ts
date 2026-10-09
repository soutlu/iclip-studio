/**
 * 一条 (对话, agent) 流的读取通道，照 Kimi 的 hY：REST 基线、实时批次、历史分页与它们之间的先后都在这里。
 *
 * - refresh 与 loadOlder 共用一条串行读取链；读取在途时到达的批次先缓冲，读完按到达顺序回放，旧响应不会盖掉新批次。
 * - 批次号规则照 Kimi：不大于已应用的是重复，直接认下；不是下一号就报断档，交给池重读基线再重订。
 * - append 缺口也照 Kimi：同批其余操作照常应用、水位照常赋值，再报断档，由池用基线纠正。
 * - epoch（Kimi 的 Transcript 流没有）：批次所属的实时流与已应用的不同，同样报断档。少了这一条，
 *   重启后新流的低号批次会落进「重复」分支被悄悄认下，直到下一次重读才发现。
 */

import type { StreamWatermark, TranscriptOps } from './connection'
import type { AgentDescriptor, PageRequest, TranscriptPage } from './transcript.api'
import {
  AgentTranscript,
  itemId,
  type ActivityMeta,
  type AgentTranscriptSnapshot,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptOperation,
  type TranscriptPrompt,
  type TranscriptTurn,
} from './vendor'

/** 通用默认页大小（Kimi hY 默认 20）；主会话池覆盖为 10。 */
export const DEFAULT_PAGE_SIZE = 20

/** 基线带来的信封字段；未读到基线时都为空。 */
export interface PageHeader {
  title: string
  ownerUserId: string | null
  deletedAt: string | null
  forkedFrom: string | null
  forkTurn: number | null
}

const EMPTY_HEADER: PageHeader = {
  deletedAt: null,
  forkTurn: null,
  forkedFrom: null,
  ownerUserId: null,
  title: '',
}

/** 通道里能给界面看的那部分；池再补上加载状态与错误。 */
export interface ChannelData extends PageHeader {
  /** 直接使用 transcript meta 判定当前运行状态。 */
  activity: ActivityMeta
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  items: readonly TranscriptItem[]
  /** 排队消息尚未进入时间线，仅存在 prompts 中。 */
  prompts: readonly TranscriptPrompt[]
  /** 审批展示与移除均由服务端待处理交互集合驱动。 */
  pendingInteractions: readonly TranscriptInteraction[]
  /** 全部交互（含已决定的），按 id 查；工具卡凭 approvalId 认出被拒绝的那一步。 */
  interactions: ReadonlyMap<string, TranscriptInteraction>
  /** 当前最早一轮之前是否还有更早的轮次。 */
  hasMoreOlder: boolean
  /** 正在读更早的一页。 */
  loadingOlder: boolean
  /** 上一次读更早的一页失败了，可以再试。 */
  loadOlderError: boolean
}

export interface ChannelOptions {
  agentId: string
  pageSize?: number
  fetchPage: (request: PageRequest) => Promise<TranscriptPage>
  onChange?: () => void
  /** 批次号接不上、append 位置对不上、或批次不属于当前实时流。 */
  onGap?: () => void
}

interface BufferedBatch {
  ops: TranscriptOps
  seq: number | undefined
  epoch: string
}

/** 按条目 id 去重合并，旧页在前（Kimi 的 CFe）。 */
const mergeItems = (
  older: readonly TranscriptItem[],
  current: readonly TranscriptItem[],
): TranscriptItem[] => {
  const seen = new Set<string>()
  const merged: TranscriptItem[] = []
  for (const item of [...older, ...current]) {
    const id = itemId(item)
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(item)
  }
  return merged
}

export class TranscriptChannel {
  readonly agentId: string
  private transcript: AgentTranscript
  private readonly fetchPage: ChannelOptions['fetchPage']
  private readonly pageSize: number
  private readonly onChange: (() => void) | undefined
  private readonly onGap: (() => void) | undefined

  private seq_: number | undefined
  private epoch_: string | undefined
  private header: PageHeader = EMPTY_HEADER
  private agents_: readonly AgentDescriptor[] = []
  private buffered: BufferedBatch[] = []
  private readChain: Promise<void> = Promise.resolve()
  private activeReads = 0
  private refreshPromise: Promise<void> | null = null
  private loadingOlder_ = false
  private loadOlderTask: Promise<void> | undefined
  private loadOlderError_ = false

  constructor(options: ChannelOptions) {
    this.agentId = options.agentId
    this.transcript = new AgentTranscript(options.agentId)
    this.fetchPage = options.fetchPage
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
    this.onChange = options.onChange
    this.onGap = options.onGap
  }

  /** 拿基线订阅、续订时带上的水位；还没读到基线时为 undefined。 */
  get watermark(): StreamWatermark | undefined {
    return this.seq_ === undefined || this.epoch_ === undefined
      ? undefined
      : { epoch: this.epoch_, seq: this.seq_ }
  }

  get agents(): readonly AgentDescriptor[] {
    return this.agents_
  }

  get loadingOlder(): boolean {
    return this.loadingOlder_ || this.loadOlderTask !== undefined
  }

  get hasMoreOlder(): boolean {
    return this.transcript.hasMoreOlder
  }

  /** 读取排队串行：第一个立刻开始，其余接在链上；收尾时回放缓冲的批次。 */
  private enqueueRead(read: () => Promise<void>, settle: () => void): Promise<void> {
    const first = this.activeReads === 0
    this.activeReads += 1
    const task = (
      first ? new Promise<void>((resolve) => resolve(read())) : this.readChain.then(read)
    ).finally(() => {
      this.activeReads -= 1
      settle()
      const pending = this.buffered
      this.buffered = []
      for (const batch of pending) this.applyOps(batch.ops, batch.seq, batch.epoch)
      this.onChange?.()
    })
    this.readChain = task.catch(() => {})
    return task
  }

  /** 重读最新一页并整份替换（Kimi 的 refresh）；已有在途的就复用它。 */
  refresh(): Promise<void> {
    if (this.refreshPromise !== null) return this.refreshPromise
    const task = this.enqueueRead(
      async () => {
        this.applyPage(await this.fetchPage({ pageSize: this.pageSize }), true)
      },
      () => {
        this.refreshPromise = null
      },
    )
    this.refreshPromise = task
    this.onChange?.()
    return task
  }

  /** 实时 reset：整份替换，并无条件覆写水位与它所属的流。 */
  receiveReset(snapshot: AgentTranscriptSnapshot, seq: number | undefined, epoch: string): void {
    this.transcript.apply([{ agentId: this.agentId, op: 'reset', snapshot }])
    if (seq !== undefined) {
      this.seq_ = seq
      this.epoch_ = epoch
    }
    this.onChange?.()
  }

  /** 应用一批实时操作；返回 false 表示没有应用，连接不推进水位。 */
  applyOps(ops: TranscriptOps, seq: number | undefined, epoch: string): boolean {
    if (this.refreshPromise !== null || this.loadingOlder) {
      this.buffered.push({ epoch, ops, seq })
      return false
    }
    // Kimi 的 hY 没有这一步。它是 epoch 规则在客户端的直接推论：批次号只在同一条实时流里可比，
    // 换了流的批次不论号大号小都接不上；不拦下的话，重启后新流的低号批次会被当成重复批次悄悄认下。
    if (this.epoch_ !== undefined && epoch !== this.epoch_) {
      this.onGap?.()
      return false
    }
    if (seq !== undefined && this.seq_ !== undefined) {
      if (seq <= this.seq_) return true
      if (seq !== this.seq_ + 1) {
        this.onGap?.()
        return false
      }
    }
    // 类型断言衔接 vendor 的可选字段与 zod 推导出的 undefined，见 transcript.api.ts。
    const result = this.transcript.apply(ops as readonly TranscriptOperation[])
    if (seq !== undefined) {
      this.seq_ = seq
      this.epoch_ = epoch
    }
    if (result.gap !== undefined) this.onGap?.()
    if (result.accepted.length > 0) this.onChange?.()
    return result.gap === undefined
  }

  /** 读当前最早一轮之前的一页，合并到前面（Kimi 的 loadOlder）；失败时抛出，由调用方提示重试。 */
  async loadOlder(): Promise<void> {
    if (!this.hasMoreOlder || this.loadingOlder) return
    const task = this.enqueueRead(
      async () => {
        if (!this.hasMoreOlder) return
        const earliest = this.transcript.getItems().find((item) => item.kind === 'turn')
        if (earliest?.kind !== 'turn') return
        this.loadingOlder_ = true
        this.loadOlderError_ = false
        this.onChange?.()
        try {
          this.applyPage(
            await this.fetchPage({ beforeTurn: earliest.turnId, pageSize: this.pageSize }),
            false,
          )
        } catch (error) {
          this.loadOlderError_ = true
          throw error
        }
      },
      () => {
        this.loadingOlder_ = false
        this.loadOlderTask = undefined
      },
    )
    this.loadOlderTask = task
    try {
      await task
    } finally {
      if (this.loadOlderTask === task) this.loadOlderTask = undefined
    }
  }

  /** 等在途的旧页读完；没有就立即完成。 */
  settleOlder(): Promise<void> {
    return this.loadOlderTask ?? Promise.resolve()
  }

  /** 最新一页整份替换；旧页只把条目合并到前面，附属实体取这一页（都是请求时刻的当前事实）。 */
  private applyPage(page: TranscriptPage, full: boolean): void {
    this.agents_ = page.agents
    if (full) {
      this.header = {
        deletedAt: page.deletedAt,
        forkTurn: page.forkTurn,
        forkedFrom: page.forkedFrom,
        ownerUserId: page.ownerUserId,
        title: page.title,
      }
      this.receiveReset(page.snapshot, page.seq, page.epoch)
      return
    }
    const snapshot: AgentTranscriptSnapshot = {
      ...page.snapshot,
      hasMoreOlder: page.hasMoreOlder,
      items: mergeItems(page.snapshot.items, this.transcript.getItems()),
    }
    this.transcript.apply([{ agentId: this.agentId, op: 'reset', snapshot }])
    this.onChange?.()
  }

  /** 时间线里的轮，供本地发送状态判断认领与收尾。 */
  turns(): readonly TranscriptTurn[] {
    return this.transcript.getItems().filter((item): item is TranscriptTurn => item.kind === 'turn')
  }

  /** 每次都现算；池在合并通知时调用并缓存，保证同一版的引用稳定。 */
  data(): ChannelData {
    const meta = this.transcript.getMeta()
    return {
      ...this.header,
      activity: meta.activity ?? 'unknown',
      contextTokens: meta.agent?.contextTokens,
      hasMoreOlder: this.transcript.hasMoreOlder,
      interactions: this.transcript.getInteractions(),
      items: this.transcript.getItems(),
      loadOlderError: this.loadOlderError_,
      loadingOlder: this.loadingOlder,
      maxContextTokens: meta.agent?.maxContextTokens,
      pendingInteractions: this.transcript
        .listPendingInteractions()
        .flatMap((id) => this.transcript.getInteraction(id) ?? []),
      prompts: [...this.transcript.getPrompts().values()],
    }
  }
}
