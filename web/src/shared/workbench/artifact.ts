import type { ComponentType } from 'react'
import type { IconName } from '@/shared/icons'

export interface FileArtifactSource {
  kind: 'file'
  path: string
  version: number
}

export interface FrameAgentRef {
  agentId: string
}

export interface FrameArtifactSource {
  kind: 'frame'
  toolCallId: string
  view: string
  metadata: unknown
  display?: unknown
  agentRefs?: readonly FrameAgentRef[]
}

export interface WorkspaceArtifactSource {
  kind: 'workspace'
  fileCount: number
}

/** 按 `{ anyPath }` 认领的产物：`paths` 是工作区里在的那几份。 */
export interface PathsArtifactSource {
  kind: 'paths'
  paths: readonly string[]
}

export type ArtifactSource =
  FileArtifactSource | FrameArtifactSource | WorkspaceArtifactSource | PathsArtifactSource

export interface Artifact {
  id: string
  type: string
  title: string
  source: ArtifactSource
}

export interface ArtifactRendererProps {
  conversationId: string
  artifact: Artifact
  readOnly: boolean
}

/**
 * 一类产物的登记项。`match` 决定它认领什么：
 * - `{ path }` / `{ pattern }`：每份路径命中的文件一件，id 是 `file:<path>`；
 * - `{ anyPath }`：工作区里有其中任一份文件时一件，id 是 `type`；
 * - `{ workspace: true }`：工作区里有文件时一件，id 是 `workspace`；
 * - `{ displayKind }`：每个展示类型命中的工具调用一件，id 是 `frame:<toolCallId>`。
 * 除 `displayKind` 外都是常驻类型，有产物时总占着页签。`hiddenWhenReadOnly` 为真时，只读查看的
 * 对话里没有这类产物，带着地址也选不中。
 */
export interface ArtifactEntry {
  type: string
  match:
    | { path: string }
    | { pattern: string }
    | { anyPath: readonly string[] }
    | { displayKind: string }
    | { workspace: true }
  label: string
  title: (source: ArtifactSource) => string
  detail?: (source: ArtifactSource) => string | undefined
  icon: IconName
  component: ComponentType<ArtifactRendererProps>
  autoOpen: boolean
  empty?: string
  hiddenWhenReadOnly?: boolean
}

export interface WorkbenchFile {
  path: string
  version: number
}

export interface WorkbenchFrame {
  toolCallId: string
  view: string
  metadata?: unknown
  display?: unknown
  agentRefs?: readonly FrameAgentRef[]
}

export const fileArtifactId = (path: string) => `file:${path}`

export const frameArtifactId = (toolCallId: string) => `frame:${toolCallId}`

export const WORKSPACE_ARTIFACT_ID = 'workspace'
