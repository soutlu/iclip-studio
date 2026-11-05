import type { ComposerPart } from '@/shared/ui/composer'
import type { AnnotationNode } from './image-edit/annotation-node'
import { MAX_PART_NAME } from './image-edit/image-edit-draft'
import type { EditDraftPart } from './image-edit/image-edit-types'

type ImageSlot = { key: string; url: string | undefined }

export const imageSlotsOf = (parts: readonly ComposerPart<AnnotationNode>[]): ImageSlot[] =>
  parts.flatMap((part) =>
    part.kind === 'media' && part.media.status !== 'error'
      ? [{ key: part.media.url ?? part.media.attId, url: part.media.url }]
      : [],
  )

export const draftPartsOf = (parts: readonly ComposerPart<AnnotationNode>[]): EditDraftPart[] => {
  const result: EditDraftPart[] = []
  const pushText = (text: string) => {
    const previous = result.at(-1)
    if (previous?.kind === 'text')
      result[result.length - 1] = { kind: 'text', text: previous.text + text }
    else result.push({ kind: 'text', text })
  }
  for (const part of parts) {
    if (part.kind === 'text') pushText(part.text)
    else if (part.kind === 'node') result.push({ kind: 'annotation', ...part.node.attrs })
    else if (part.media.status === 'ready' && part.media.url !== undefined)
      result.push({
        kind: 'image',
        name: part.media.name.slice(0, MAX_PART_NAME),
        url: part.media.url,
      })
  }
  return result
}

export const compileReferencePrompt = (
  parts: readonly EditDraftPart[],
): { text: string; referenceImageUrls: string[] } => {
  const referenceImageUrls: string[] = []
  const text = parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'annotation') return ''
      if (!referenceImageUrls.includes(part.url)) referenceImageUrls.push(part.url)
      return `@Image${referenceImageUrls.indexOf(part.url) + 1}`
    })
    .join('')
  return { referenceImageUrls, text }
}

export const MAX_FIRST_FRAMES = 2

export const compileImageClipPrompt = (
  parts: readonly EditDraftPart[],
): { text: string; referenceImageUrls: string[] } => {
  const compiled = compileReferencePrompt(parts)
  if (compiled.referenceImageUrls.length > MAX_FIRST_FRAMES) return compiled
  const text = parts
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/^[^\S\n]+|[^\S\n]+$/gm, '')
  return { referenceImageUrls: compiled.referenceImageUrls, text }
}
