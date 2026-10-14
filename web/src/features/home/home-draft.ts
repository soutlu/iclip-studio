/** 首页输入框未发送的草稿：正文、已传好的附件、所选创作助手与合集，存在本标签页的 sessionStorage。
 * 做同款不进草稿；上传中与上传失败的附件没有可复用的地址，存不了。 */

import { z } from 'zod'
import { readyAttachment, type ComposerPart } from '@/shared/ui/composer'

/** 草稿形状变了就换前缀，旧草稿自然作废。 */
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
/** 选择记下是谁选的：换了登录人就不算数。 */
const ownerSchema = z.string().nullable()
const draftSchema = z.object({
  parts: z.array(partSchema),
  agent: z.object({ ownerUserId: ownerSchema, id: idSchema }).nullable(),
  /** id 为 null 是明确选了不关联合集。 */
  collection: z.object({ ownerUserId: ownerSchema, id: idSchema.nullable() }).nullable(),
})

export type HomeDraft = z.infer<typeof draftSchema>
type HomeDraftPart = HomeDraft['parts'][number]

export const EMPTY_HOME_DRAFT: HomeDraft = { agent: null, collection: null, parts: [] }

/** 没存过是空草稿；存的内容读不出来或形状不对时抛错，由调用方提示。 */
export function loadHomeDraft(): HomeDraft {
  const raw = sessionStorage.getItem(HOME_DRAFT_KEY)
  if (raw === null) return EMPTY_HOME_DRAFT
  const parsed = draftSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('首页草稿无法读取')
  return parsed.data
}

/** 输入框内容转成可存的草稿：相邻文字合并，只留就绪且有地址的图片与视频。 */
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

/** 草稿还原成输入框内容；附件复用公网地址，不重新上传。 */
export const composerPartsOf = (parts: readonly HomeDraftPart[]): ComposerPart[] =>
  parts.map((part) =>
    part.kind === 'text'
      ? part
      : {
          kind: 'media',
          media: readyAttachment({ kind: part.mediaKind, name: part.name, url: part.url }),
        },
  )
