const CARD_GUTTER = 12

const NOTCH_INSET = 28

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
