export type SortKey = readonly [at: string, tail: string]

const newestFirst = ([atA, tailA]: SortKey, [atB, tailB]: SortKey) =>
  Date.parse(atB) - Date.parse(atA) || (tailB > tailA ? 1 : tailB < tailA ? -1 : 0)

const createdKey = (row: { createdAt: string; id: string }): SortKey => [row.createdAt, row.id]

export const byCreatedDesc = (
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
) => newestFirst(createdKey(a), createdKey(b))

export const pageBy = <T>(
  rows: readonly T[],
  keyOf: (row: T) => SortKey,
  cursor: string | null,
  limit: number,
) => {
  const sorted = [...rows].sort((a, b) => newestFirst(keyOf(a), keyOf(b)))
  const separator = cursor?.indexOf('|') ?? -1
  const rest =
    cursor === null
      ? sorted
      : sorted.filter(
          (row) =>
            newestFirst(keyOf(row), [cursor.slice(0, separator), cursor.slice(separator + 1)]) > 0,
        )
  const items = rest.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: items.length === limit && last ? keyOf(last).join('|') : null }
}

export const pageByCreated = <T extends { createdAt: string; id: string }>(
  rows: readonly T[],
  cursor: string | null,
  limit: number,
) => pageBy(rows, createdKey, cursor, limit)

let lastCreatedMs = 0

export const mockCreatedAt = (): string => {
  lastCreatedMs = Math.max(Date.now(), lastCreatedMs + 1)
  return new Date(lastCreatedMs).toISOString()
}

export const resetMockClock = () => {
  lastCreatedMs = 0
}
