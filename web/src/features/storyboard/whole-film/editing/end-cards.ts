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

/** 品牌模板里能填进组件可填项的内容 */
export type BrandRole = 'name' | 'slogan'

/**
 * 加片头或片尾（各至多一个）：片头放最前、片尾放最后，默认 2 秒；整片剩余时长不够时缩短到剩余时长。
 * variables 是组件的默认可填项，品牌名、标语已由调用方填成品牌模板的值。
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
 * 换片头或片尾的组件：时长与转场不变；可填项取新组件的默认值，其中对得上品牌模板的项
 * （brandFields：可填项 id → 品牌内容）沿用这一端原来填的值，用户改过的品牌名、标语因此带过去。
 */
export const replaceEndCardComponent = (
  draft: WholeFilmDraft,
  args: {
    role: EndCardRole
    component: string
    variables: ComponentVariables
    brandFields: Record<string, BrandRole>
  },
): EditResult => {
  const clip = endCard(draft, args.role)
  if (!clip) return refuse('unknown-clip')
  if (clip.component === args.component) return done(draft)
  const carried: Partial<Record<BrandRole, string | number | boolean>> = {}
  for (const [id, value] of Object.entries(clip.variables)) {
    const role = args.brandFields[id]
    if (role) carried[role] = value
  }
  const variables = { ...args.variables }
  for (const id of Object.keys(variables)) {
    const role = args.brandFields[id]
    const value = role === undefined ? undefined : carried[role]
    if (value !== undefined) variables[id] = value
  }
  return done({
    ...draft,
    layer0: draft.layer0.map((c) =>
      c.id === clip.id ? { ...clip, component: args.component, variables } : c,
    ),
  })
}
