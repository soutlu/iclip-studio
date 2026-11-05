const CARD_GUTTER = 12

const NOTCH_INSET = 28

const MIN_CARD_WIDTH = 360

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

export const narrowedCardWidth = (room: number, cardWidth: number): number | undefined =>
  cardWidth > room - 2 * CARD_GUTTER ? Math.max(MIN_CARD_WIDTH, room - 2 * CARD_GUTTER) : undefined
