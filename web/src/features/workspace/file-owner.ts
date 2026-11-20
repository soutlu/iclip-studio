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
 * 这份文件归哪个页签（按登记的路径认领），用来给「打开 X」直达按钮和目录树里的色调。
 * 只读对话里不出现的页签不算。
 */
export const fileOwnerOf = (
  registry: ArtifactRegistry,
  path: string,
  readOnly: boolean,
): FileOwner | undefined => {
  const artifact = registry.matchFiles([{ path, version: 0 }])[0]
  if (artifact === undefined) return undefined
  const entry = registry.resolve(artifact.type)
  if (entry === undefined || (readOnly && entry.hiddenWhenReadOnly === true)) return undefined
  return {
    artifactId: artifact.id,
    icon: entry.icon,
    title: artifact.title,
    tone: TAB_TONES[artifact.type],
  }
}
