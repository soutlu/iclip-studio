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
  type TranscriptTask,
  type TranscriptTurn,
} from './vendor'

export const DEFAULT_PAGE_SIZE = 20

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

export interface ChannelData extends PageHeader {
  activity: ActivityMeta
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  items: readonly TranscriptItem[]
  prompts: readonly TranscriptPrompt[]
  pendingInteractions: readonly TranscriptInteraction[]
  interactions: ReadonlyMap<string, TranscriptInteraction>
  tasks: ReadonlyMap<string, TranscriptTask>
  hasMoreOlder: boolean
  loadingOlder: boolean
  loadOlderError: boolean
}

export interface ChannelOptions {
  agentId: string
  pageSize?: number
  fetchPage: (request: PageRequest) => Promise<TranscriptPage>
  onChange?: () => void
  onGap?: () => void
}

interface BufferedBatch {
  ops: TranscriptOps
  seq: number | undefined
  epoch: string
}

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

  receiveReset(snapshot: AgentTranscriptSnapshot, seq: number | undefined, epoch: string): void {
    this.transcript.apply([{ agentId: this.agentId, op: 'reset', snapshot }])
    if (seq !== undefined) {
      this.seq_ = seq
      this.epoch_ = epoch
    }
    this.onChange?.()
  }

  applyOps(ops: TranscriptOps, seq: number | undefined, epoch: string): boolean {
    if (this.refreshPromise !== null || this.loadingOlder) {
      this.buffered.push({ epoch, ops, seq })
      return false
    }
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
    const result = this.transcript.apply(ops as readonly TranscriptOperation[])
    if (seq !== undefined) {
      this.seq_ = seq
      this.epoch_ = epoch
    }
    if (result.gap !== undefined) this.onGap?.()
    if (result.accepted.length > 0) this.onChange?.()
    return result.gap === undefined
  }

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

  settleOlder(): Promise<void> {
    return this.loadOlderTask ?? Promise.resolve()
  }

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

  turns(): readonly TranscriptTurn[] {
    return this.transcript.getItems().filter((item): item is TranscriptTurn => item.kind === 'turn')
  }

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
      tasks: this.transcript.getTasks(),
    }
  }
}
