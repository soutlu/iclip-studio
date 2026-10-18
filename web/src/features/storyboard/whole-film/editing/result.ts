import type { WholeFilmDraft } from './draft'

/** 操作被拒的原因；能收紧到边界内的输入会被收紧，不算被拒 */
export type Refusal =
  | 'unknown-clip'
  | 'unknown-source'
  | 'unknown-music'
  | 'not-a-video'
  | 'outside-source'
  | 'too-short'
  | 'film-too-long'
  | 'overlay-too-long'
  | 'nothing-to-split'
  | 'no-music'
  | 'no-beats'
  | 'drop-elsewhere'

export type EditResult = { ok: true; draft: WholeFilmDraft } | { ok: false; refusal: Refusal }

export const done = (draft: WholeFilmDraft): EditResult => ({ ok: true, draft })

export const refuse = (refusal: Refusal): EditResult => ({ ok: false, refusal })
