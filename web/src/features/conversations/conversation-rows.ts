/**
 * 对话行池：照 Kimi 的 `kimi.sessions`，一段对话在浏览器里只有一份行，侧栏、更多分页、搜索、全部对话页与
 * 需求单面板的查询只管成员、游标与计数，渲染时按 id 从这里取行。
 *
 * 帧上没有序号，按到达先后生效（合同 §5「全局帧」）。HTTP 行可能读在途中到达的帧之前，所以用记录本对齐：
 * - 每次拉 HTTP 行，发请求之前开一本（`track` 或 `open`），结果回来合并完就关；出错或中止也关。
 * - 帧到了立刻生效，同时记进所有开着的记录本。记标题、忙闲与新建 / 修改帧；删除帧到达就记墓碑，不必重放。
 * - 结果回来先整行替换，再按到达顺序把这本记录本里这些 id 的帧重放一遍：读期间到达的帧盖得住稍旧的结果。
 * - 新建 / 修改帧只换 `activity` 以外的字段：帧里的活动是后端写库时读的，可能比随后从运行时来的
 *   `work_changed` 旧。这一行池里还没有时整行收下，活动一起收。
 * - 行不在池里时的标题帧、忙闲帧：有请求在途就只记进记录本，等结果回来重放；没有就丢掉，下次拉列表会读到。
 * - 开跑的忙闲帧顺带把收尾标记清成空（服务端开跑抹标记，帧里不另带）。
 * - 删除记墓碑：之后 `deletedAt` 为空的行一律不再收（对话 id 不复用），带 `deletedAt` 的墓碑行（治理者复盘）照收。
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { zConversationOut } from '@/shared/api/generated/zod.gen'
import type { SessionRow } from '@/shared/transcript/connection'

type Row = SessionRow
type Turn = Pick<Row['activity'], 'busy' | 'lastTurnReason' | 'pendingInteraction'>

/** 记进记录本、结果回来时重放的帧。 */
type Frame =
  | { kind: 'title'; conversationId: string; title: string }
  | { kind: 'activity'; conversationId: string; turn: Turn }
  | { kind: 'row'; conversationId: string; row: Row }

/** 一次 HTTP 读取的记录本：开着期间到达的帧按先后记下，由 `mergeRows` 重放。 */
export interface RowBook {
  readonly closed: boolean
  /** 不再记帧；关几次都一样。 */
  close(): void
}

const ROW_KEYS = Object.keys(zConversationOut.shape) as (keyof Row)[]

/** 池里只存 ConversationOut 的字段；全部对话页行上的额外字段留在查询里，由 resolve 拼回去。 */
const pickRow = (row: Row): Row => Object.fromEntries(ROW_KEYS.map((key) => [key, row[key]])) as Row

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
    key === 'activity' ? sameTurn(turnOf(left), turnOf(right)) : left[key] === right[key],
  )
}

/** 一帧落到池里已有的一行上；新建 / 修改帧保留这一行的活动。 */
const applyTo = (row: Row, frame: Frame): Row => {
  switch (frame.kind) {
    case 'title':
      return { ...row, title: frame.title }
    case 'activity':
      return {
        ...row,
        activity: { ...row.activity, ...frame.turn },
        completedAt: frame.turn.busy ? null : row.completedAt,
      }
    case 'row':
      return { ...pickRow(frame.row), activity: row.activity }
  }
}

export class ConversationRowStore {
  private readonly rows = new Map<string, Row>()
  private readonly tombstones = new Set<string>()
  /** 开着的记录本。 */
  private readonly books = new Set<RowBook>()
  /** 每本记录本开着期间到达的帧。 */
  private readonly recorded = new WeakMap<RowBook, Frame[]>()
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
    return this.rows.get(conversationId)
  }

  isDeleted(conversationId: string): boolean {
    return this.tombstones.has(conversationId)
  }

  /** 视图用：传入查询里的行，换成池里的当前行；删掉的活行返回 null。带额外字段的行保留那些字段。 */
  resolve<T extends Row>(row: T): T | null {
    if (row.deletedAt === null && this.tombstones.has(row.id)) return null
    const current = this.rows.get(row.id)
    if (current === undefined || current === row) return row
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

  /** 开一本记录本；要在发 HTTP 请求之前开，合并完、出错或中止时都要关。 */
  open(): RowBook {
    const books = this.books
    const book: RowBook = {
      get closed() {
        return !books.has(book)
      },
      close: () => void books.delete(book),
    }
    books.add(book)
    this.recorded.set(book, [])
    return book
  }

  /**
   * 开着记录本读一次 HTTP 行：`read` 发请求，`merge` 拿结果与这本记录本调 `mergeRows`。
   * 不论成败都在返回前关掉记录本。
   */
  async track<T, R>(read: () => Promise<T>, merge: (result: T, book: RowBook) => R): Promise<R> {
    const book = this.open()
    try {
      return merge(await read(), book)
    } finally {
      book.close()
    }
  }

  /**
   * HTTP 行进池，返回合并后的行（保留调用方行上的额外字段），删掉的活行被滤掉。
   * 先整行替换，再把 `book` 里这些 id 的帧按到达顺序重放。不关记录本：一次结果可以分几次合并。
   */
  mergeRows<T extends Row>(rows: readonly T[], book: RowBook): T[] {
    const frames = this.recorded.get(book) ?? []
    return this.batch(() =>
      rows.flatMap((row) => {
        if (row.deletedAt === null && this.tombstones.has(row.id)) return []
        let next = pickRow(row)
        for (const frame of frames) {
          if (frame.conversationId !== row.id || this.revives(frame)) continue
          next = applyTo(next, frame)
        }
        this.commit(row.id, next)
        const resolved = this.resolve(row)
        return resolved === null ? [] : [resolved]
      }),
    )
  }

  applyTitle(conversationId: string, title: string): void {
    this.receive({ conversationId, kind: 'title', title })
  }

  applyActivity(conversationId: string, turn: Turn): void {
    this.receive({ conversationId, kind: 'activity', turn })
  }

  /** `created` / `updated` 带来的整行。 */
  applyRow(row: Row): void {
    this.receive({ conversationId: row.id, kind: 'row', row })
  }

  /**
   * 删除：记墓碑，视图里的活行随即消失。不进记录本：墓碑一直在，结果回来合并时照墓碑规则滤掉，
   * 重放它不会再改什么。
   */
  applyDeleted(conversationId: string): void {
    if (this.tombstones.has(conversationId)) return
    this.tombstones.add(conversationId)
    this.touch()
  }

  // --- 内部 -----------------------------------------------------------------

  /** 帧到了：记进每一本开着的记录本，再落到池里。 */
  private receive(frame: Frame): void {
    for (const book of this.books) this.recorded.get(book)?.push(frame)
    this.batch(() => {
      const id = frame.conversationId
      const current = this.rows.get(id)
      if (frame.kind === 'row') {
        if (this.revives(frame)) return
        this.commit(id, current === undefined ? pickRow(frame.row) : applyTo(current, frame))
        return
      }
      // 行还不在池里：标题与活动没处落，在途的请求结果回来时从记录本重放。
      if (current !== undefined) this.commit(id, applyTo(current, frame))
    })
  }

  /** 删掉以后来的活行（`deletedAt` 为空的整行帧）不收：到达时与重放时都按墓碑挡掉。 */
  private revives(frame: Frame): boolean {
    return (
      frame.kind === 'row' &&
      frame.row.deletedAt === null &&
      this.tombstones.has(frame.conversationId)
    )
  }

  private commit(conversationId: string, next: Row): void {
    const current = this.rows.get(conversationId)
    if (current !== undefined && sameRow(current, next)) return
    this.rows.set(conversationId, next)
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
