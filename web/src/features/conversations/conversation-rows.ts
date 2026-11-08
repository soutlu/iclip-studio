import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { zConversationOut } from '@/shared/api/generated/zod.gen'
import type { SessionRow } from '@/shared/transcript/connection'

type Row = SessionRow
type Turn = Pick<Row['activity'], 'busy' | 'lastTurnReason' | 'pendingInteraction'>

type Frame =
  | { kind: 'title'; conversationId: string; title: string }
  | { kind: 'activity'; conversationId: string; turn: Turn }
  | { kind: 'row'; conversationId: string; row: Row }

export interface RowBook {
  readonly closed: boolean
  close(): void
}

const ROW_KEYS = Object.keys(zConversationOut.shape) as (keyof Row)[]

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

const sameRow = (left: Row, right: Row): boolean => {
  const keys = Object.keys(right) as (keyof Row)[]
  if (keys.length !== Object.keys(left).length) return false
  return keys.every((key) =>
    key === 'activity' ? sameTurn(turnOf(left), turnOf(right)) : left[key] === right[key],
  )
}

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
  private readonly books = new Set<RowBook>()
  private readonly recorded = new WeakMap<RowBook, Frame[]>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private batching = 0
  private dirty = false
  private readonly resolved = new WeakMap<Row, WeakMap<object, unknown>>()
  private readonly liveLists = new WeakMap<readonly Row[], readonly Row[]>()
  private readonly keptLists = new WeakMap<readonly Row[], readonly Row[]>()

  get(conversationId: string): Row | undefined {
    return this.rows.get(conversationId)
  }

  isDeleted(conversationId: string): boolean {
    return this.tombstones.has(conversationId)
  }

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

  batch<T>(work: () => T): T {
    this.batching += 1
    try {
      return work()
    } finally {
      this.batching -= 1
      if (this.batching === 0 && this.dirty) this.emit()
    }
  }

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

  async track<T, R>(read: () => Promise<T>, merge: (result: T, book: RowBook) => R): Promise<R> {
    const book = this.open()
    try {
      return merge(await read(), book)
    } finally {
      book.close()
    }
  }

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

  applyRow(row: Row): void {
    this.receive({ conversationId: row.id, kind: 'row', row })
  }

  applyDeleted(conversationId: string): void {
    if (this.tombstones.has(conversationId)) return
    this.tombstones.add(conversationId)
    this.touch()
  }

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
      if (current !== undefined) this.commit(id, applyTo(current, frame))
    })
  }

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

export const conversationRowsOf = (queryClient: QueryClient): ConversationRowStore => {
  let store = stores.get(queryClient)
  if (store === undefined) {
    store = new ConversationRowStore()
    stores.set(queryClient, store)
  }
  return store
}

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

export const useConversationRow = <T extends Row>(row: T | undefined): T | null | undefined => {
  const store = conversationRowsOf(useQueryClient())
  useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.snapshotVersion(),
  )
  return row === undefined ? undefined : store.resolve(row)
}
