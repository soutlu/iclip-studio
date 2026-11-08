import type { EditFrame, ImageAnnotation } from './image-edit-types'

export type EditMentionItem =
  | { kind: 'base'; url: string }
  | { kind: 'annotation'; annotation: ImageAnnotation }
  | { kind: 'frame'; frame: number; url: string; name: string }

export const mentionLabelOf = (item: EditMentionItem): string =>
  item.kind === 'base'
    ? '编辑底图'
    : item.kind === 'annotation'
      ? `标注 ${item.annotation.number}`
      : item.name

export function editMentionItems({
  annotations,
  baseUrl,
  frames,
  query,
}: {
  annotations: readonly ImageAnnotation[]
  baseUrl: string | undefined
  frames: readonly EditFrame[]
  query: string
}): EditMentionItem[] {
  const items: EditMentionItem[] = [
    ...(baseUrl === undefined ? [] : [{ kind: 'base' as const, url: baseUrl }]),
    ...annotations
      .toSorted((a, b) => a.number - b.number)
      .map((annotation) => ({ annotation, kind: 'annotation' as const })),
    ...frames.map(({ name, url }, index) => ({
      frame: index + 1,
      kind: 'frame' as const,
      name,
      url,
    })),
  ]
  return items.filter((item) => mentionLabelOf(item).includes(query))
}
