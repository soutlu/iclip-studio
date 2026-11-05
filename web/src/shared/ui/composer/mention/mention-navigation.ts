export type MentionArrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

export type OptionBox = { left: number; top: number; width: number; height: number }

export type MentionNavigation = {
  readonly arrows: readonly MentionArrow[]
  readonly next: (index: number, arrow: MentionArrow, boxes: readonly OptionBox[]) => number
}

const centerOf = (box: OptionBox) => box.left + box.width / 2
const bottomOf = (box: OptionBox) => box.top + box.height
const sameRow = (a: OptionBox, b: OptionBox) => a.top < bottomOf(b) && b.top < bottomOf(a)

export const optionAfterArrow = (
  index: number,
  arrow: MentionArrow,
  boxes: readonly OptionBox[],
): number => {
  if (arrow === 'ArrowLeft') return Math.max(0, index - 1)
  if (arrow === 'ArrowRight') return Math.min(boxes.length - 1, index + 1)
  const current = boxes[index]
  if (current === undefined) return index
  const up = arrow === 'ArrowUp'
  const beyond = boxes.filter((box) =>
    up ? bottomOf(box) <= current.top : box.top >= bottomOf(current),
  )
  const nearest = beyond.reduce<OptionBox | undefined>(
    (best, box) =>
      best === undefined || (up ? bottomOf(box) > bottomOf(best) : box.top < best.top) ? box : best,
    undefined,
  )
  if (nearest === undefined) return index
  let best = index
  let distance = Number.POSITIVE_INFINITY
  for (const [position, box] of boxes.entries()) {
    if (!beyond.includes(box) || !sameRow(box, nearest)) continue
    const gap = Math.abs(centerOf(box) - centerOf(current))
    if (gap < distance) {
      best = position
      distance = gap
    }
  }
  return best
}

export const linearNavigation: MentionNavigation = {
  arrows: ['ArrowUp', 'ArrowDown'],
  next: (index, arrow, boxes) =>
    arrow === 'ArrowUp'
      ? Math.max(0, index - 1)
      : arrow === 'ArrowDown'
        ? Math.max(0, Math.min(boxes.length - 1, index + 1))
        : index,
}

export const gridNavigation: MentionNavigation = {
  arrows: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
  next: optionAfterArrow,
}
