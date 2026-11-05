import { z } from 'zod'
import { MAX_ANNOTATIONS, MAX_EDIT_REFERENCES } from '../generation-limits'
import { editTargetKeyParts } from './edit-target'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

export const MAX_PART_NAME = 200

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

const draftsSchema = z.record(urlSchema, draftSchema)

export type FrameEditDrafts = z.infer<typeof draftsSchema>

const EMPTY_DRAFT: FrameEditDraft = { annotations: [], parts: [] }

export const editDraftKey = (target: FrameEditTarget) =>
  `cue:frame-edit-v2:${target.conversationId}:${editTargetKeyParts(target).join(':')}`

export function loadEditDrafts(target: FrameEditTarget): FrameEditDrafts {
  const raw = sessionStorage.getItem(editDraftKey(target))
  if (raw === null) return {}
  const parsed = draftsSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('本地图片编辑草稿无法读取')
  return parsed.data
}

export const draftOf = (drafts: FrameEditDrafts, baseUrl: string): FrameEditDraft =>
  drafts[baseUrl] ?? EMPTY_DRAFT

export const isEmptyDraft = (draft: FrameEditDraft): boolean =>
  draft.annotations.length === 0 && draft.parts.length === 0

export const TOO_MANY_ANNOTATIONS = `每张图片最多添加 ${MAX_ANNOTATIONS} 个标注`

export const submittedImageCount = (parts: FrameEditDraft['parts'], baseUrl: string): number =>
  1 +
  new Set(
    parts.flatMap((part) => (part.kind === 'image' && part.url !== baseUrl ? [part.url] : [])),
  ).size

export function editDraftError(draft: FrameEditDraft, baseUrl: string): string | null {
  if (draft.annotations.length > MAX_ANNOTATIONS) return TOO_MANY_ANNOTATIONS
  if (draft.annotations.reduce((total, annotation) => total + annotation.points.length, 0) > 10000)
    return '标注点数过多，请简化画笔标注'
  if (draft.parts.length > 200) return '引用片段过多，请简化修改要求'
  if (
    draft.parts.reduce((total, part) => total + (part.kind === 'text' ? part.text.length : 0), 0) >
    4000
  )
    return '修改要求最多 4000 字'
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
