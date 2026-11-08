import type { PlacedCaption } from './composition/captions'
import type { WholeFilmDraft } from './editing/draft'
import type { Selection } from './selection'

const CAPTION_PREFIX = 'caption:'

export const captionKey = (caption: PlacedCaption) =>
  `${caption.clipId}:${caption.subtitleJobId}:${caption.sentenceIndex}`

export function selectionOfHfId(
  hfId: string,
  draft: WholeFilmDraft,
  captions: readonly PlacedCaption[],
): NonNullable<Selection> | undefined {
  if (hfId.startsWith(CAPTION_PREFIX)) {
    const index = hfId.slice(CAPTION_PREFIX.length)
    if (!/^\d+$/.test(index)) return undefined
    const caption = captions[Number(index)]
    return caption === undefined ? undefined : { kind: 'caption', key: captionKey(caption) }
  }
  if (draft.layer0.some((clip) => clip.id === hfId)) return { kind: 'clip', ids: [hfId] }
  if (draft.overlays.some((overlay) => overlay.id === hfId)) return { kind: 'overlay', id: hfId }
  return undefined
}

export function hfIdOnScreen(
  selection: Selection,
  draft: WholeFilmDraft,
  captions: readonly PlacedCaption[],
  ms: number,
): string | undefined {
  if (selection === null || selection.kind === 'music') return undefined
  const within = (start: number, end: number) => start <= ms && ms < end
  if (selection.kind === 'caption') {
    const index = captions.findIndex((caption) => captionKey(caption) === selection.key)
    const caption = captions[index]
    return caption !== undefined && within(caption.start, caption.end)
      ? `${CAPTION_PREFIX}${index}`
      : undefined
  }
  if (selection.kind === 'clip' && selection.ids.length > 1) return undefined
  const [pieces, id] =
    selection.kind === 'clip' ? [draft.layer0, selection.ids[0]] : [draft.overlays, selection.id]
  const piece = pieces.find((item) => item.id === id)
  return piece !== undefined && within(piece.start, piece.start + piece.duration)
    ? piece.id
    : undefined
}
