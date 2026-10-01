/** `@` 菜单能引用的东西：编辑底图、画布上的标注、本组的帧。 */

import type { ImageAnnotation } from './image-edit-types'

export type EditMentionItem =
  | { kind: 'base'; url: string }
  | { kind: 'annotation'; annotation: ImageAnnotation }
  | { kind: 'frame'; frame: number; url: string }

export const mentionLabelOf = (item: EditMentionItem): string =>
  item.kind === 'base'
    ? '编辑底图'
    : item.kind === 'annotation'
      ? `标注 ${item.annotation.number}`
      : `帧 @${item.frame}`

/** 按分组顺序给出名称含查询词的项；标注按编号排。 */
export function editMentionItems({
  annotations,
  baseUrl,
  frames,
  query,
}: {
  annotations: readonly ImageAnnotation[]
  baseUrl: string
  frames: readonly string[]
  query: string
}): EditMentionItem[] {
  const items: EditMentionItem[] = [
    { kind: 'base', url: baseUrl },
    ...annotations
      .toSorted((a, b) => a.number - b.number)
      .map((annotation) => ({ annotation, kind: 'annotation' as const })),
    ...frames.map((url, index) => ({ frame: index + 1, kind: 'frame' as const, url })),
  ]
  return items.filter((item) => mentionLabelOf(item).includes(query))
}
