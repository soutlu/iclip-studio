/** 时间线上的说明框离所在范围两端不到这么宽时收回来、靠向里面，免得出了范围。 */
const BUBBLE_EDGE_PX = 120

/** 说明框在范围里 `left` 像素处（范围宽 `width`）时怎么靠：贴近开头左对齐，贴近结尾右对齐。 */
export const bubbleAlign = (left: number, width: number) =>
  left < BUBBLE_EDGE_PX ? 'is-start' : left > width - BUBBLE_EDGE_PX ? 'is-end' : undefined
