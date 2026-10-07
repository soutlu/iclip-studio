/** 弹出卡在舞台里的水平位置：卡（或收起后的胶囊）的中线对准时间线上选区的中线，夹在舞台里、
 * 两侧至少留 {@link CARD_GUTTER}；底边的小尖角指向选区，卡被夹住时尖角在卡上挪过去，但不戳到圆角上。 */

/** 卡与舞台左右两边至少隔多少像素。 */
const CARD_GUTTER = 12

/** 尖角中线离卡的左右两边至少多少像素：卡的圆角是 20px，尖角半宽 6px，再留一点。 */
const NOTCH_INSET = 28

/**
 * @param stageWidth 舞台宽，像素。
 * @param anchorX 选区中线在舞台里的横坐标，像素。
 * @param cardWidth 卡（或胶囊）的宽，像素。
 * @returns 卡左边在舞台里的横坐标，以及尖角中线在卡里的横坐标，像素。
 */
export const placeCard = (
  stageWidth: number,
  anchorX: number,
  cardWidth: number,
): { left: number; notch: number } => {
  const left = Math.max(
    CARD_GUTTER,
    Math.min(stageWidth - cardWidth - CARD_GUTTER, anchorX - cardWidth / 2),
  )
  const notch = Math.max(NOTCH_INSET, Math.min(cardWidth - NOTCH_INSET, anchorX - left))
  return { left, notch }
}
