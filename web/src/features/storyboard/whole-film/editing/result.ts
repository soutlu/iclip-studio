import type { WholeFilmDraft } from './draft'

export type Refusal =
  | 'unknown-clip'
  | 'not-contiguous'
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
