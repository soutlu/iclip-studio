/**
 * 对话行池：照 Kimi 的 `kimi.sessions`，一段对话在浏览器里只有一份行，侧栏、更多分页、搜索、全部对话页与
 * 需求单面板的查询只管成员、游标与计数，渲染时按 id 从这里取行。
 *
 * 合并规则见合同 §5「全局帧」与 ADR-0004：
 * - 字段分组记水位：标题、收尾标记、轮次活动（busy / 待处理 / 结局）、视频汇总、其余事实字段。
 * - 事件帧在提交后发号；HTTP 行的 `lastSeq` 是读库之前的水位。HTTP 行只盖过水位不大于 `lastSeq` 的分组。
 * - `created` / `updated` 帧：事实字段（标题、收尾、其余）按信封序号记水位；活动按行内 `lastSeq` 与 HTTP 行同一口径。
 * - 视频汇总没有帧来源，只随行更新，单独成组，免得被活动帧的水位挡住。
 * - 序号只在同一 epoch 内可比。epoch 按本池第一次见到的先后排：没见过的视为最新，整行收下并把水位重置到它；
 *   比这一行当前 epoch 更早的来源一律丢弃。
 * - 删除记墓碑：之后 `deletedAt` 为空的行一律不再收（对话 id 不复用），带 `deletedAt` 的墓碑行（治理者复盘）照收。
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { zConversationOut } from '@/shared/api/generated/zod.gen'
import type { SessionEventMark, SessionRow } from '@/shared/transcript/connection'

type Row = SessionRow
type Turn = Pick<Row['activity'], 'busy' | 'lastTurnReason' | 'pendingInteraction'>

const GROUPS = ['title', 'completed', 'turn', 'video', 'facts'] as const
type Group = (typeof GROUPS)[number]
type Marks = Record<Group, number>

/** 帧带来的、行还没到时先记下的各组取值。 */
interface Pending {
  title?: string
  completedAt?: string | null
  turn?: Turn
}

interface Entry {
  epoch: string
  marks: Marks
  /** 还没有任何 HTTP 行或整行帧时为 null，帧值先记在 pending 里。 */
  row: Row | null
  pending: Pending
}

const ROW_KEYS = Object.keys(zConversationOut.shape) as (keyof Row)[]

/** 池里只存 ConversationOut 的字段；全部对话页行上的额外字段留在查询里，由 resolve 拼回去。 */
const pickRow = (row: Row): Row => Object.fromEntries(ROW_KEYS.map((key) => [key, row[key]])) as Row

const marksAt = (seq: number): Marks => ({
  completed: seq,
  facts: seq,
  title: seq,
  turn: seq,
  video: seq,
})

const turnOf = (row: Row): Turn => ({
  busy: row.activity.busy,
  lastTurnReason: row.activity.lastTurnReason,
  pendingInteraction: row.activity.pendingInteraction,
})

const sameTurn = (left: Turn, right: Turn): boolean =>
  left.busy === right.busy &&
  left.pendingInteraction === right.pendingInteraction &&
  (left.lastTurnReason ?? null) === (right.lastTurnReason ?? null)

/** 两行逐字段相同就返回旧引用，未变化的行不让视图重渲。 */
const sameRow = (left: Row, right: Row): boolean => {
  const keys = Object.keys(right) as (keyof Row)[]
  if (keys.length !== Object.keys(left).length) return false
  return keys.every((key) =>
    key === 'activity'
      ? sameTurn(turnOf(left), turnOf(right)) &&
        left.activity.videoGeneration === right.activity.videoGeneration
      : left[key] === right[key],
  )
}

/** 由各组来源拼出一行：facts 给底，其余组各取自己那份。 */
const compose = (
  facts: Row,
  sources: {
    title: string
    completedAt: string | null
    turn: Turn
    video: Row['activity']['videoGeneration']
  },
  lastSeq: number,
): Row => ({
  ...facts,
  activity: { ...facts.activity, ...sources.turn, videoGeneration: sources.video },
  completedAt: sources.completedAt,
  lastSeq,
  title: sources.title,
})

export class ConversationRowStore {
  private readonly entries = new Map<string, Entry>()
  private readonly tombstones = new Set<string>()
  /** epoch 第一次被见到的次序，越大越新。 */
  private readonly epochs = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private batching = 0
  private dirty = false
  /** resolve 带额外字段的行（全部对话页的 latestMasterUrl）时按 (池里的行, 传入的行) 缓存，保持引用稳定。 */
  private readonly resolved = new WeakMap<Row, WeakMap<object, unknown>>()
  private readonly liveLists = new WeakMap<readonly Row[], readonly Row[]>()
  private readonly keptLists = new WeakMap<readonly Row[], readonly Row[]>()

  // --- 读 -------------------------------------------------------------------

  get(conversationId: string): Row | undefined {
    return this.entries.get(conversationId)?.row ?? undefined
  }

  isDeleted(conversationId: string): boolean {
    return this.tombstones.has(conversationId)
  }

  /** 视图用：传入查询里的行，换成池里的当前行；删掉的活行返回 null。带额外字段的行保留那些字段。 */
  resolve<T extends Row>(row: T): T | null {
    if (row.deletedAt === null && this.tombstones.has(row.id)) return null
    const current = this.entries.get(row.id)?.row
    if (current === undefined || current === null || current === row) return row
    if (Object.keys(row).length === Object.keys(current).length) return current as T
    let byInput = this.resolved.get(current)
    if (byInput === undefined) {
      byInput = new WeakMap()
      this.resolved.set(current, byInput)
    }
    const cached = byInput.get(row) as T | undefined
    if (cached !== undefined) return cached
    const merged = { ...row, ...current }
    byInput.set(row, merged)
    return merged
  }

  /**
   * 整组版本：逐行 resolve，删掉的活行按 `keepDeleted` 去留。每个元素与上次一样时返回上次的数组（照 Kimi `Cw`），
   * 按传入数组缓存，查询数据不变、池里这些行也没变时视图拿到同一个引用。
   */
  resolveAll<T extends Row>(rows: readonly T[], keepDeleted: boolean): readonly T[] {
    const next = rows.flatMap((row) => {
      const resolved = this.resolve(row)
      if (resolved !== null) return [resolved]
      return keepDeleted ? [row] : []
    })
    const cache = keepDeleted ? this.keptLists : this.liveLists
    const previous = cache.get(rows) as readonly T[] | undefined
    if (
      previous !== undefined &&
      previous.length === next.length &&
      previous.every((row, index) => row === next[index])
    ) {
      return previous
    }
    cache.set(rows, next)
    return next
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  snapshotVersion(): number {
    return this.version
  }

  // --- 写 -------------------------------------------------------------------

  /** 一批写入只通知一次，照 Kimi 把同一拍到达的事件合批落地。 */
  batch<T>(work: () => T): T {
    this.batching += 1
    try {
      return work()
    } finally {
      this.batching -= 1
      if (this.batching === 0 && this.dirty) this.emit()
    }
  }

  /**
   * HTTP 行进池，返回合并后的行（保留调用方行上的额外字段），删掉的活行被滤掉。
   * 照 Kimi `setSessionsPreservingLiveUsage`：只盖过水位不大于这一行 `lastSeq` 的分组。
   */
  mergeRows<T extends Row>(rows: readonly T[]): T[] {
    return this.batch(() =>
      rows.flatMap((row) => {
        if (row.deletedAt === null && this.tombstones.has(row.id)) return []
        this.mergeRow(row)
        const resolved = this.resolve(row)
        return resolved === null ? [] : [resolved]
      }),
    )
  }

  applyTitle(conversationId: string, title: string, mark: SessionEventMark): void {
    this.applyFields(conversationId, mark, { title })
  }

  /** 开跑与收尾互斥：busy 帧顺带把收尾标记记成空，水位同这一帧（服务端开跑抹标记不另发帧）。 */
  applyActivity(conversationId: string, turn: Turn, mark: SessionEventMark): void {
    this.applyFields(conversationId, mark, turn.busy ? { completedAt: null, turn } : { turn })
  }

  /** `created` / `updated`：事实字段按信封序号，活动按行内 `lastSeq`。 */
  applyRow(row: Row, mark: SessionEventMark): void {
    this.batch(() => {
      if (this.tombstones.has(row.id) && row.deletedAt === null) return
      const entry = this.entryFor(row.id, mark.epoch)
      if (entry === null) return
      const facts = mark.seq > entry.marks.facts || entry.row === null ? row : entry.row
      const title = mark.seq > entry.marks.title ? row.title : this.titleOf(entry, row)
      const completedAt =
        mark.seq > entry.marks.completed ? row.completedAt : this.completedOf(entry, row)
      const turn = entry.marks.turn <= row.lastSeq ? turnOf(row) : this.turnOfEntry(entry, row)
      const video =
        entry.marks.video <= row.lastSeq || entry.row === null
          ? row.activity.videoGeneration
          : entry.row.activity.videoGeneration
      const next = compose(facts, { completedAt, title, turn, video }, row.lastSeq)
      for (const group of ['facts', 'title', 'completed'] as const) {
        entry.marks[group] = Math.max(entry.marks[group], mark.seq)
      }
      entry.marks.turn = Math.max(entry.marks.turn, row.lastSeq)
      entry.marks.video = Math.max(entry.marks.video, row.lastSeq)
      entry.pending = {}
      this.commit(entry, next)
    })
  }

  /** 删除：记墓碑，视图里的活行随即消失。 */
  applyDeleted(conversationId: string): void {
    if (this.tombstones.has(conversationId)) return
    this.tombstones.add(conversationId)
    this.touch()
  }

  // --- 内部 -----------------------------------------------------------------

  private rankOf(epoch: string): number {
    let rank = this.epochs.get(epoch)
    if (rank === undefined) {
      rank = this.epochs.size
      this.epochs.set(epoch, rank)
    }
    return rank
  }

  /**
   * 取或建这一行的条目，并处理 epoch：同 epoch 原样返回；来源更新（含没见过的）就把水位清零、改记新 epoch；
   * 来源更旧返回 null，调用方丢弃。
   */
  private entryFor(conversationId: string, epoch: string): Entry | null {
    const entry = this.entries.get(conversationId)
    if (entry === undefined) {
      this.rankOf(epoch)
      const created: Entry = { epoch, marks: marksAt(0), pending: {}, row: null }
      this.entries.set(conversationId, created)
      return created
    }
    if (entry.epoch === epoch) return entry
    if (this.rankOf(epoch) < this.rankOf(entry.epoch)) return null
    entry.epoch = epoch
    entry.marks = marksAt(0)
    entry.pending = {}
    return entry
  }

  private mergeRow(row: Row): void {
    const known = this.entries.get(row.id)
    const fresh = known === undefined || known.row === null
    const entry = this.entryFor(row.id, row.eventEpoch)
    if (entry === null) return
    const lastSeq = row.lastSeq
    const takes = (group: Group) => fresh || entry.marks[group] <= lastSeq
    const facts = takes('facts') || entry.row === null ? pickRow(row) : entry.row
    const title = entry.marks.title <= lastSeq ? row.title : this.titleOf(entry, row)
    const completedAt =
      entry.marks.completed <= lastSeq ? row.completedAt : this.completedOf(entry, row)
    const turn = entry.marks.turn <= lastSeq ? turnOf(row) : this.turnOfEntry(entry, row)
    const video =
      takes('video') || entry.row === null
        ? row.activity.videoGeneration
        : entry.row.activity.videoGeneration
    const next = compose(
      facts,
      { completedAt, title, turn, video },
      Math.max(lastSeq, entry.row?.lastSeq ?? 0),
    )
    for (const group of GROUPS) entry.marks[group] = Math.max(entry.marks[group], lastSeq)
    entry.pending = {}
    this.commit(entry, next)
  }

  /** 帧带来的字段：序号大于这一组水位才落，行还没到就先记在 pending。 */
  private applyFields(
    conversationId: string,
    mark: SessionEventMark,
    fields: { title?: string; completedAt?: string | null; turn?: Turn },
  ): void {
    this.batch(() => {
      const entry = this.entryFor(conversationId, mark.epoch)
      if (entry === null) return
      const pending: Pending = { ...entry.pending }
      if (fields.title !== undefined && mark.seq > entry.marks.title) {
        pending.title = fields.title
        entry.marks.title = mark.seq
      }
      if (fields.completedAt !== undefined && mark.seq > entry.marks.completed) {
        pending.completedAt = fields.completedAt
        entry.marks.completed = mark.seq
      }
      if (fields.turn !== undefined && mark.seq > entry.marks.turn) {
        pending.turn = fields.turn
        entry.marks.turn = mark.seq
      }
      if (entry.row === null) {
        entry.pending = pending
        return
      }
      const row = entry.row
      const next = compose(
        row,
        {
          completedAt: 'completedAt' in pending ? (pending.completedAt ?? null) : row.completedAt,
          title: pending.title ?? row.title,
          turn: pending.turn ?? turnOf(row),
          video: row.activity.videoGeneration,
        },
        row.lastSeq,
      )
      entry.pending = {}
      this.commit(entry, next)
    })
  }

  private titleOf(entry: Entry, fallback: Row): string {
    return entry.pending.title ?? entry.row?.title ?? fallback.title
  }

  private completedOf(entry: Entry, fallback: Row): string | null {
    if ('completedAt' in entry.pending) return entry.pending.completedAt ?? null
    return entry.row === null ? fallback.completedAt : entry.row.completedAt
  }

  private turnOfEntry(entry: Entry, fallback: Row): Turn {
    return entry.pending.turn ?? (entry.row === null ? turnOf(fallback) : turnOf(entry.row))
  }

  private commit(entry: Entry, next: Row): void {
    if (entry.row !== null && sameRow(entry.row, next)) return
    entry.row = next
    this.touch()
  }

  private touch(): void {
    this.version += 1
    if (this.batching > 0) this.dirty = true
    else this.emit()
  }

  private emit(): void {
    this.dirty = false
    for (const listener of this.listeners) listener()
  }
}

const stores = new WeakMap<QueryClient, ConversationRowStore>()

/** 行池跟着 QueryClient 走：应用里一份，测试里每个 QueryClient 各一份，互不串。 */
export const conversationRowsOf = (queryClient: QueryClient): ConversationRowStore => {
  let store = stores.get(queryClient)
  if (store === undefined) {
    store = new ConversationRowStore()
    stores.set(queryClient, store)
  }
  return store
}

/**
 * 视图取行（照 Kimi `sessionViews`）：查询给成员与顺序，行取池里的当前值。
 * `keepDeleted` 为真时保留已删的活行（全部对话页带墓碑的筛选下，由重拉换成带 `deletedAt` 的那一行）。
 * 每一行与整个数组在没有变化时保持原引用。
 */
export const useConversationRows = <T extends Row>(
  rows: readonly T[],
  { keepDeleted = false }: { keepDeleted?: boolean } = {},
): readonly T[] => {
  const store = conversationRowsOf(useQueryClient())
  useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.snapshotVersion(),
  )
  return store.resolveAll(rows, keepDeleted)
}

/** 单行版本：删掉的活行返回 null。 */
export const useConversationRow = <T extends Row>(row: T | undefined): T | null | undefined => {
  const store = conversationRowsOf(useQueryClient())
  useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.snapshotVersion(),
  )
  return row === undefined ? undefined : store.resolve(row)
}
