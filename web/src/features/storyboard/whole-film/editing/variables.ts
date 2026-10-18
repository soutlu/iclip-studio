import type { ComponentVariables, WholeFilmDraft } from './draft'
import { done, refuse, type EditResult } from './result'

/** 改组件片段（成片轨上的组件段、特效块）的可填项；只影响这条整片 */
export const setComponentVariables = (
  draft: WholeFilmDraft,
  args: { id: string; variables: ComponentVariables },
): EditResult => {
  const { id, variables } = args
  if (draft.layer0.some((c) => c.id === id && c.type === 'component')) {
    return done({
      ...draft,
      layer0: draft.layer0.map((c) =>
        c.id === id && c.type === 'component' ? { ...c, variables } : c,
      ),
    })
  }
  if (draft.overlays.some((o) => o.id === id)) {
    return done({
      ...draft,
      overlays: draft.overlays.map((o) => (o.id === id ? { ...o, variables } : o)),
    })
  }
  return refuse('unknown-clip')
}
