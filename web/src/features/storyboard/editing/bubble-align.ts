const BUBBLE_EDGE_PX = 120

export const bubbleAlign = (left: number, width: number) =>
  left < BUBBLE_EDGE_PX ? 'is-start' : left > width - BUBBLE_EDGE_PX ? 'is-end' : undefined
