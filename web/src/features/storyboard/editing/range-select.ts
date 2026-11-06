export const contiguousRange = <T>(
  order: readonly T[],
  selected: readonly T[],
): { from: number; to: number } | undefined => {
  const [first] = selected
  if (first === undefined) return undefined
  const from = order.indexOf(first)
  if (from < 0) return undefined
  return selected.every((item, offset) => order[from + offset] === item)
    ? { from, to: from + selected.length - 1 }
    : undefined
}

export const shiftSelect = <T>(
  order: readonly T[],
  selected: readonly T[],
  clicked: T,
): readonly T[] => {
  const index = order.indexOf(clicked)
  if (index < 0) return selected
  const range = contiguousRange(order, selected)
  if (range === undefined) return [clicked]
  const { from, to } = range
  if (index === from - 1 || index === to + 1)
    return order.slice(Math.min(index, from), Math.max(index, to) + 1)
  if (index === from) return selected.slice(1)
  if (index === to) return selected.slice(0, -1)
  return [clicked]
}

export const stepSelect = <T>(
  order: readonly T[],
  selected: readonly T[],
  focusId: T,
  direction: -1 | 1,
  extend: boolean,
): { focus: T; selection: readonly T[] } => {
  const focus = order.indexOf(focusId)
  const target = order[focus + direction]
  if (focus < 0 || target === undefined) return { focus: focusId, selection: selected }
  if (!extend) return { focus: target, selection: [target] }
  const range = contiguousRange(order, selected)
  const anchor =
    range === undefined || (focus !== range.from && focus !== range.to)
      ? focus
      : focus === range.from
        ? range.to
        : range.from
  const next = focus + direction
  return {
    focus: target,
    selection: order.slice(Math.min(anchor, next), Math.max(anchor, next) + 1),
  }
}
