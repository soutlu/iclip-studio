/**
 * 选区是 order 里连续的一串，按先后排。返回它在 order 里占的 [from, to]；为空、有不在 order 里的、
 * 或不连续时为 undefined。
 */
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

/**
 * Shift 点选 clicked：点选区左右紧挨的一项扩选；点选区最左或最右一项把它去掉，只剩它时全部取消
 * （返回空）；点选区中间、不相邻的项，或当前选区不是 order 里连续的一串时，只选 clicked。
 * clicked 不在 order 里时原样返回 selected。
 */
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

/**
 * 键盘挪选区：不按 Shift 选中相邻的那个；按 Shift 时焦点在选区一端，往外扩、往里收，另一端不动。
 * 返回新的焦点与选区；到头了原样返回。
 */
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
