import type { QueryClient } from '@tanstack/react-query'
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

/** 按 `{ anyPath }` 规则匹配的产物来源：`paths` 为工作区中实际存在的匹配文件路径集合。 */
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

/** 用户可在工作台内新建的产物创建配置（见 `ArtifactEntry.create`）。 */
export interface ArtifactCreate {
  /**
   * 创建该类产物，返回新建并归属此登记项的工作区文件路径（宿主据此定位页签）。若已由他处创建则按成功处理；
   * 失败时抛出异常，宿主通过 `errorMessageOf(error, '<label> 新建失败')` 提示用户。
   */
  run: (conversationId: string, queryClient: QueryClient) => Promise<string>
  /** 对话打开期间由 Agent 创建该类产物时，工作台自动切换页签并展示的提示文案。 */
  agentCreatedNotice: string
}

/**
 * 产物类型登记项。`match` 定义匹配规则：
 * - `{ path }` / `{ pattern }`：每个命中路径的文件对应一件产物，ID 为 `file:<path>`；
 * - `{ anyPath }`：工作区存在列表中任一文件时生成一件产物，ID 为 `type`；配置 `dir` 后，该目录下的其余文件也归属此产物
 *   （文件页展示「打开 X」直达按钮），但仅 `anyPath` 中的文件决定产物是否存在；
 * - `{ workspace: true }`：工作区非空时生成一件产物，ID 为 `workspace`；
 * - `{ displayKind }`：每个匹配展示类型的工具调用对应一件产物，ID 为 `frame:<toolCallId>`。
 * 除 `displayKind` 外均为常驻类型，存在产物时固定占用页签。`hiddenWhenReadOnly` 为 `true` 时，
 * 只读对话中不生成该类产物，携带 URL 参数亦无法选中。
 * 配置 `create` 后，在非只读对话且尚未存在该产物时，工作台顶栏「+」、空态选择器与收起竖轨均提供新建入口。
 * 页签内容默认包裹在宿主的浮起面板与外边距中；`frameless` 为 `true` 时由渲染器自行绘制面板与边距，宿主直接挂载。
 */
export interface ArtifactEntry {
  type: string
  match:
    | { path: string }
    | { pattern: string }
    | { anyPath: readonly string[]; dir?: string }
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
  create?: ArtifactCreate
  frameless?: boolean
}

/** 已配置 `create` 的产物登记项。 */
export type CreatableEntry = ArtifactEntry & { create: ArtifactCreate }

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
