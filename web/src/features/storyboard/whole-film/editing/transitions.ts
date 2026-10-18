import type { EditContext } from './context'
import type { ComponentVariables, TransitionClip, WholeFilmDraft } from './draft'
import { done, refuse, type EditResult } from './result'
import { checkTransitions, nextId, normalize } from './timeline'

/**
 * 在 afterClipId 那一段后面的切点放转场；这个切点已有转场就换掉它。最后一段后面没有切点。
 * 时长就是组件原定的时长；切点前后两段放不下这个转场（规则同合成构建的 `transitionWindow`）时拒绝。
 */
export const setTransition = (
  draft: WholeFilmDraft,
  args: { afterClipId: string; component: string; variables: ComponentVariables },
  context: EditContext,
): EditResult => {
  const index = draft.layer0.findIndex((clip) => clip.id === args.afterClipId)
  if (index < 0) return refuse('unknown-clip')
  if (index === draft.layer0.length - 1) return refuse('not-a-cut')
  const spec = context.transitions[args.component]
  if (spec === undefined) return refuse('unknown-component')
  const existing = draft.transitions.find((t) => t.afterClipId === args.afterClipId)
  const transition: TransitionClip = {
    id: existing?.id ?? nextId(draft, 't'),
    afterClipId: args.afterClipId,
    component: args.component,
    duration: spec.durationMs,
    variables: args.variables,
  }
  return checkTransitions(
    normalize({
      ...draft,
      transitions: existing
        ? draft.transitions.map((t) => (t === existing ? transition : t))
        : [...draft.transitions, transition],
    }),
    context,
  )
}

export const removeTransition = (
  draft: WholeFilmDraft,
  args: { transitionId: string },
): EditResult => {
  if (!draft.transitions.some((t) => t.id === args.transitionId)) return refuse('unknown-clip')
  return done({
    ...draft,
    transitions: draft.transitions.filter((t) => t.id !== args.transitionId),
  })
}
