import type { IconName } from '@/shared/icons'
import type { ArtifactRegistry } from '@/shared/workbench'
import type { Tone } from './file-kind'

// 页签的色调：分镜 slate、final-cut copper，其余页签没定
const TAB_TONES: Partial<Record<string, Tone>> = { 'final-cut': 'copper', storyboard: 'slate' }

export type FileOwner = {
  artifactId: string
  title: string
  icon: IconName
  tone: Tone | undefined
}

/**
 * 这份文件归哪个页签（见 `ArtifactRegistry.ownerOf`），用来给「打开 X」直达按钮和目录树里的色调。
 * 只读对话里不出现的页签不算。
 */
export const fileOwnerOf = (
  registry: ArtifactRegistry,
  path: string,
  readOnly: boolean,
): FileOwner | undefined => {
  const owner = registry.ownerOf(path)
  if (owner === undefined) return undefined
  const entry = registry.resolve(owner.type)
  if (entry === undefined || (readOnly && entry.hiddenWhenReadOnly === true)) return undefined
  return {
    artifactId: owner.id,
    icon: entry.icon,
    title: owner.title,
    tone: TAB_TONES[owner.type],
  }
}
