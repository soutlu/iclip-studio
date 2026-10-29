const CARD_GUTTER = 12

const NOTCH_INSET = 28

/** 卡让开别的浮层时最多收窄到这么宽，再窄输入框与工具条就挤不下了。 */
const MIN_CARD_WIDTH = 360

/** `room` 是卡能用的宽：从舞台左边到舞台右边，或到要让开的浮层左边。 */
export const placeCard = (
  room: number,
  anchorX: number,
  cardWidth: number,
): { left: number; notch: number } => {
  const left = Math.max(
    CARD_GUTTER,
    Math.min(room - cardWidth - CARD_GUTTER, anchorX - cardWidth / 2),
  )
  const notch = Math.max(NOTCH_INSET, Math.min(cardWidth - NOTCH_INSET, anchorX - left))
  return { left, notch }
}

/** 卡在 `room` 里两边留白放不下时收窄到的宽度，最窄 360；放得下时为 undefined。 */
export const narrowedCardWidth = (room: number, cardWidth: number): number | undefined =>
  cardWidth > room - 2 * CARD_GUTTER ? Math.max(MIN_CARD_WIDTH, room - 2 * CARD_GUTTER) : undefined
