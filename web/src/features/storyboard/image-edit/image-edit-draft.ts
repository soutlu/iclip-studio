import { z } from 'zod'
import { MAX_ANNOTATIONS, MAX_EDIT_REFERENCES } from '../generation-limits'
import { editTargetKeyParts } from './edit-target'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

/** 草稿里图片名的长度上限：上传的文件名、恢复时取的文件名都按它截。 */
export const MAX_PART_NAME = 200

// 编辑器内部的形状，不进 HTTP：提交时只发编译好的 prompt 与图片地址。
const idSchema = z.string().min(1).max(100)
const urlSchema = z.string().min(1).max(4096)
const draftSchema = z.object({
  annotations: z
    .array(
      z.object({
        id: idSchema,
        number: z.int().min(1).max(9999),
        kind: z.enum(['point', 'rectangle', 'ellipse', 'arrow', 'pen']),
        points: z
          .array(z.object({ x: z.number(), y: z.number() }))
          .min(1)
          .max(2000),
      }),
    )
    .max(MAX_ANNOTATIONS),
  parts: z.array(
    z.union([
      z.object({ kind: z.literal('text'), text: z.string() }),
      z.object({
        kind: z.literal('image'),
        url: urlSchema,
        name: z.string().min(1).max(MAX_PART_NAME),
      }),
      z.object({ kind: z.literal('annotation'), id: idSchema, number: z.int().min(1).max(9999) }),
    ]),
  ),
})

/** 一格上每张底图各一份草稿：圈画在哪张图上，修改要求里的标注 chip 就指着那张图上的圈。
 * 换底图等于换一套输入，不能混用。 */
const draftsSchema = z.record(urlSchema, draftSchema)

export type FrameEditDrafts = z.infer<typeof draftsSchema>

/** 没写过草稿的底图共用这一份：反复取到的是同一个对象。 */
const EMPTY_DRAFT: FrameEditDraft = { annotations: [], parts: [] }

/** 草稿按格存，不按底图地址：应用之后这一格换了图，别的底图上没提交完的输入还在。
 * 形状换过一次（修改要求从「芯片 + 参考图列表」改成正文里的 parts），前缀随之换，旧草稿自然作废。 */
export const editDraftKey = (target: FrameEditTarget) =>
  `cue:frame-edit-v2:${target.conversationId}:${editTargetKeyParts(target).join(':')}`

export function loadEditDrafts(target: FrameEditTarget): FrameEditDrafts {
  const raw = sessionStorage.getItem(editDraftKey(target))
  if (raw === null) return {}
  const parsed = draftsSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('本地图片编辑草稿无法读取')
  return parsed.data
}

/** 取这张底图的草稿；没写过就是空的。 */
export const draftOf = (drafts: FrameEditDrafts, baseUrl: string): FrameEditDraft =>
  drafts[baseUrl] ?? EMPTY_DRAFT

export const isEmptyDraft = (draft: FrameEditDraft): boolean =>
  draft.annotations.length === 0 && draft.parts.length === 0

/** 标注超出上限的提示，画布拦截新增与提交前终校共用。 */
export const TOO_MANY_ANNOTATIONS = `每张图片最多添加 ${MAX_ANNOTATIONS} 个标注`

/** 本次要提交的图片张数：底图（干净的或标注图）固定占一张，正文里的其他图片按地址去重。 */
export const submittedImageCount = (parts: FrameEditDraft['parts'], baseUrl: string): number =>
  1 +
  new Set(
    parts.flatMap((part) => (part.kind === 'image' && part.url !== baseUrl ? [part.url] : [])),
  ).size

/** 提交前终校；`null` 表示可以提交。 */
export function editDraftError(draft: FrameEditDraft, baseUrl: string): string | null {
  if (draft.annotations.length > MAX_ANNOTATIONS) return TOO_MANY_ANNOTATIONS
  if (draft.annotations.reduce((total, annotation) => total + annotation.points.length, 0) > 10000)
    return '标注点数过多，请简化画笔标注'
  if (draft.parts.length > 200) return '引用片段过多，请简化修改要求'
  if (
    draft.parts.reduce((total, part) => total + (part.kind === 'text' ? part.text.length : 0), 0) >
    4000
  )
    return '修改要求不能超过 4000 字'
  if (draft.parts.every((part) => part.kind !== 'text' || part.text.trim() === ''))
    return '请填写修改要求'
  if (
    draft.parts.some(
      (part) =>
        part.kind === 'annotation' &&
        !draft.annotations.some((annotation) => annotation.id === part.id),
    )
  )
    return '修改要求中有已删除的标注，请处理失效引用'
  if (submittedImageCount(draft.parts, baseUrl) > MAX_EDIT_REFERENCES)
    return `每次最多提交 ${MAX_EDIT_REFERENCES} 张图片`
  return null
}
