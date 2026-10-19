/**
 * 合成页上的 data-hf-id 与编辑器选中之间的对应。合成构建在每一段、每一块的最外层写草稿 id，
 * 字幕组件在每一句上写 `caption:N`，N 是 `placeCaptions` 结果的下标。
 */
import type { PlacedCaption } from './composition/captions'
import type { WholeFilmDraft } from './editing/draft'
import type { Selection } from './film-tracks'

const CAPTION_PREFIX = 'caption:'

/**
 * 一块字幕的身份：哪段画面里、哪条字幕记录的第几句。选中字幕记这个，不记下标：草稿一变，
 * 放进整片的字幕重新排，下标就会错位。
 */
export const captionKey = (caption: PlacedCaption) =>
  `${caption.clipId}:${caption.subtitleJobId}:${caption.sentenceIndex}`

/** 合成页上的 data-hf-id 是哪一块；组件自带的、对不上当前草稿的返回 undefined */
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
  if (draft.layer0.some((clip) => clip.id === hfId)) return { kind: 'clip', id: hfId }
  if (draft.overlays.some((overlay) => overlay.id === hfId)) return { kind: 'overlay', id: hfId }
  return undefined
}

/**
 * 选中的这一块在合成页上写的 data-hf-id；在这一刻之外（不在它的时间范围里）、或不在画面上
 * （音乐）时为 undefined，不画选中框。
 */
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
  const pieces = selection.kind === 'clip' ? draft.layer0 : draft.overlays
  const piece = pieces.find((item) => item.id === selection.id)
  return piece !== undefined && within(piece.start, piece.start + piece.duration)
    ? piece.id
    : undefined
}
