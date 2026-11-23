import type { IconName } from '@/shared/icons'
import type { ArtifactRegistry } from '@/shared/workbench'
import type { Tone } from './file-kind'

// 产物页签色调映射：分镜为 slate、final-cut 为 copper，其余页签沿用文件类型色调
const TAB_TONES: Partial<Record<string, Tone>> = { 'final-cut': 'copper', storyboard: 'slate' }

export type FileOwner = {
  artifactId: string
  title: string
  icon: IconName
  /** 所属页签色调，未指定时为 `undefined`。 */
  tone: Tone | undefined
  /** 是否为页签本身的主文档；仅因位于页签目录下而归属时为 `false`。 */
  document: boolean
}

/**
 * 解析文件归属的工作台页签（见 `ArtifactRegistry.ownerOf`），用于渲染「打开 X」直达按钮。
 * 若对应页签不在当前 `tabs`（工作台有效产物 ID 集合）中——如主文件尚未生成或只读对话中隐藏——则返回 `undefined`。
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

/** 文件为页签主文档时返回页签色调（用于目录树与预览头部图标）；否则返回 `undefined`，回退至文件类型色调。 */
export const documentToneOf = (owner: FileOwner | undefined): Tone | undefined =>
  owner?.document === true ? owner.tone : undefined
