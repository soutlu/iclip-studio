import {
  toOffset,
  transformed,
  type CaptionEdit,
  type ComponentVariables,
  type TransformArgs,
  type WholeFilmDraft,
} from './draft'
import { done, type EditResult } from './result'

const sameSentence = (edit: CaptionEdit, subtitleJobId: string, sentenceIndex: number) =>
  edit.subtitleJobId === subtitleJobId && edit.sentenceIndex === sentenceIndex

export const setCaptionText = (draft: WholeFilmDraft, args: CaptionEdit): EditResult => {
  const edit = { ...args }
  const exists = draft.captions.edits.some((e) =>
    sameSentence(e, args.subtitleJobId, args.sentenceIndex),
  )
  const edits = exists
    ? draft.captions.edits.map((e) =>
        sameSentence(e, args.subtitleJobId, args.sentenceIndex) ? edit : e,
      )
    : [...draft.captions.edits, edit]
  return done({ ...draft, captions: { ...draft.captions, edits } })
}

export const clearCaptionText = (
  draft: WholeFilmDraft,
  args: { subtitleJobId: string; sentenceIndex: number },
): EditResult => {
  const edits = draft.captions.edits.filter(
    (e) => !sameSentence(e, args.subtitleJobId, args.sentenceIndex),
  )
  return done(
    edits.length === draft.captions.edits.length
      ? draft
      : { ...draft, captions: { ...draft.captions, edits } },
  )
}

export const setCaptionsHidden = (draft: WholeFilmDraft, args: { hidden: boolean }): EditResult =>
  done(
    args.hidden === (draft.captions.hidden ?? false)
      ? draft
      : { ...draft, captions: { ...draft.captions, hidden: args.hidden } },
  )

export const setCaptionsPosition = (
  draft: WholeFilmDraft,
  args: { x: number; y: number },
): EditResult => {
  const x = toOffset(args.x)
  const y = toOffset(args.y)
  return done(
    x === (draft.captions.x ?? 0) && y === (draft.captions.y ?? 0)
      ? draft
      : { ...draft, captions: { ...draft.captions, x, y } },
  )
}

export const setCaptionsTransform = (draft: WholeFilmDraft, args: TransformArgs): EditResult => {
  const next = transformed(draft.captions, args)
  return done(next === undefined ? draft : { ...draft, captions: { ...draft.captions, ...next } })
}

export const setCaptionsVariables = (
  draft: WholeFilmDraft,
  args: { variables: ComponentVariables },
): EditResult => {
  const current = draft.captions.variables ?? {}
  const same =
    Object.keys(current).length === Object.keys(args.variables).length &&
    Object.entries(args.variables).every(([id, value]) => current[id] === value)
  return done(
    same ? draft : { ...draft, captions: { ...draft.captions, variables: args.variables } },
  )
}

export const setCaptionStyle = (draft: WholeFilmDraft, args: { component: string }): EditResult =>
  done(
    args.component === draft.captions.component
      ? draft
      : { ...draft, captions: { ...draft.captions, component: args.component } },
  )
