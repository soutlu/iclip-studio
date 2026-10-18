import {
  DEFAULT_END_CARD_MS,
  MAX_FILM_MS,
  MIN_CLIP_MS,
  type ComponentClip,
  type ComponentVariables,
  type EndCardRole,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'
import { endCard, filmDuration, insertAt, nextId, normalize } from './timeline'

/**
 * 加片头或片尾（各至多一个）：片头放最前、片尾放最后，默认 2 秒；整片剩余时长不够时缩短到剩余时长。
 * variables 是写进草稿的可填项，没写的项合成时取组件自己的默认值。
 */
export const addEndCard = (
  draft: WholeFilmDraft,
  args: {
    role: EndCardRole
    component: string
    variables: ComponentVariables
    durationMs?: number
  },
): EditResult => {
  if (endCard(draft, args.role)) return refuse('end-card-exists')
  const wanted = args.durationMs ?? DEFAULT_END_CARD_MS
  if (wanted < MIN_CLIP_MS) return refuse('too-short')
  const duration = Math.min(wanted, MAX_FILM_MS - filmDuration(draft))
  if (duration < MIN_CLIP_MS) return refuse('film-too-long')
  const clip: ComponentClip = {
    id: nextId(draft, 'c'),
    type: 'component',
    role: args.role,
    start: 0,
    duration,
    component: args.component,
    variables: args.variables,
  }
  const index = args.role === 'intro' ? 0 : draft.layer0.length
  return done(normalize({ ...draft, layer0: insertAt(draft.layer0, index, clip) }))
}

/**
 * 换片头或片尾的组件：时长与转场不变；原来填的可填项不带过去，换成 variables（新组件的可填项）。
 */
export const replaceEndCardComponent = (
  draft: WholeFilmDraft,
  args: {
    role: EndCardRole
    component: string
    variables: ComponentVariables
  },
): EditResult => {
  const clip = endCard(draft, args.role)
  if (!clip) return refuse('unknown-clip')
  if (clip.component === args.component) return done(draft)
  return done({
    ...draft,
    layer0: draft.layer0.map((c) =>
      c.id === clip.id ? { ...clip, component: args.component, variables: args.variables } : c,
    ),
  })
}
