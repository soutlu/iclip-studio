import { z } from 'zod'
import { readyAttachment, type ComposerPart } from '@/shared/ui/composer'

export const HOME_DRAFT_KEY = 'cue:home-draft-v1'

const idSchema = z.string().min(1)
const partSchema = z.union([
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('media'),
    mediaKind: z.enum(['image', 'video']),
    name: z.string(),
    url: z.string().min(1),
  }),
])
const ownerSchema = z.string().nullable()
const draftSchema = z.object({
  parts: z.array(partSchema),
  agent: z.object({ ownerUserId: ownerSchema, id: idSchema }).nullable(),
  collection: z.object({ ownerUserId: ownerSchema, id: idSchema.nullable() }).nullable(),
})

export type HomeDraft = z.infer<typeof draftSchema>
type HomeDraftPart = HomeDraft['parts'][number]

export const EMPTY_HOME_DRAFT: HomeDraft = { agent: null, collection: null, parts: [] }

export function loadHomeDraft(): HomeDraft {
  const raw = sessionStorage.getItem(HOME_DRAFT_KEY)
  if (raw === null) return EMPTY_HOME_DRAFT
  const parsed = draftSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('首页草稿无法读取')
  return parsed.data
}

export const draftPartsOf = (parts: readonly ComposerPart[]): HomeDraftPart[] => {
  const result: HomeDraftPart[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      const previous = result.at(-1)
      if (previous?.kind === 'text')
        result[result.length - 1] = { kind: 'text', text: previous.text + part.text }
      else result.push(part)
      continue
    }
    const { kind, name, status, url } = part.media
    if (status === 'ready' && url !== undefined && (kind === 'image' || kind === 'video'))
      result.push({ kind: 'media', mediaKind: kind, name, url })
  }
  return result
}

export const composerPartsOf = (parts: readonly HomeDraftPart[]): ComposerPart[] =>
  parts.map((part) =>
    part.kind === 'text'
      ? part
      : {
          kind: 'media',
          media: readyAttachment({ kind: part.mediaKind, name: part.name, url: part.url }),
        },
  )
