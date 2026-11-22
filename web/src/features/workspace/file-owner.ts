import type { IconName } from '@/shared/icons'
import type { ArtifactRegistry } from '@/shared/workbench'
import type { Tone } from './file-kind'

// 页签的色调：分镜 slate、final-cut copper，其余页签没定
const TAB_TONES: Partial<Record<string, Tone>> = { 'final-cut': 'copper', storyboard: 'slate' }

export type FileOwner = {
  artifactId: string
  title: string
  icon: IconName
  /** 页签的色调，没定时是 undefined。 */
  tone: Tone | undefined
  /** 这份文件就是页签本身的文档；只因在页签的目录里才归它时为 false。 */
  document: boolean
}

/**
 * 这份文件归哪个页签（见 `ArtifactRegistry.ownerOf`），用来给「打开 X」直达按钮。
 * 页签现在不在 `tabs`（工作台里有的产物 id）里时不算：主文件还没有，或只读对话里不显示它。
 */
export const fileOwnerOf = (
  registry: ArtifactRegistry,
  path: string,
  tabs: ReadonlySet<string>,
): FileOwner | undefined => {
  const owner = registry.ownerOf(path)
  if (owner === undefined || !tabs.has(owner.id)) return undefined
  const entry = registry.resolve(owner.type)
  if (entry === undefined) return undefined
  return {
    artifactId: owner.id,
    document: owner.document,
    icon: entry.icon,
    title: owner.title,
    tone: TAB_TONES[owner.type],
  }
}

/** 文件本身就是页签的文档时跟页签的色调（目录树、预览头部的文件图标用）；否则 undefined，按文件类型。 */
export const documentToneOf = (owner: FileOwner | undefined): Tone | undefined =>
  owner?.document === true ? owner.tone : undefined
