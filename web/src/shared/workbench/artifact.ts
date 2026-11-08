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

export type ArtifactSource = FileArtifactSource | FrameArtifactSource | WorkspaceArtifactSource

export interface Artifact {
  id: string
  type: string
  title: string
  source: ArtifactSource
}

export interface ArtifactRendererProps {
  conversationId: string
  conversationTitle: string
  artifact: Artifact
  readOnly: boolean
}

export interface ArtifactEntry {
  type: string
  match: { path: string } | { pattern: string } | { displayKind: string } | { workspace: true }
  label: string
  title: (source: ArtifactSource) => string
  detail?: (source: ArtifactSource) => string | undefined
  icon: IconName
  component: ComponentType<ArtifactRendererProps>
  autoOpen: boolean
  empty?: string
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
