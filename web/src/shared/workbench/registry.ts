/**
 * 注册表只回答「有没有专门视图认领这份数据」；没人认领的文件留给「文件」面板按原文显示。
 * 文件按确切路径或文件名模式认领，越具体越优先：确切路径 > 模式，同一种认法之间按登记先后；
 * 工具帧按 display.kind 认领，工作区有文件即命中。新增类型仅需登记渲染器。
 */

import {
  fileArtifactId,
  frameArtifactId,
  WORKSPACE_ARTIFACT_ID,
  type Artifact,
  type ArtifactEntry,
  type FrameArtifactSource,
  type WorkbenchFile,
  type WorkbenchFrame,
} from './artifact'

const displayKindOf = (display: unknown): string | undefined => {
  if (typeof display !== 'object' || display === null) return undefined
  const kind = (display as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : undefined
}

// 模式记号对应的正则：`*` 不跨 `/`，`**` 跨目录，`**` 后紧跟 `/` 时也可以一层目录都没有。
const GLOB_TOKENS = new Map([
  ['*', '[^/]*'],
  ['**', '.*'],
  ['**/', '(?:.*/)?'],
])

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 文件名模式编译成整串匹配的正则；模式之外的字符都按字面认。 */
const compilePattern = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/|\*\*|\*)/)
      .map((piece) => GLOB_TOKENS.get(piece) ?? escapeRegExp(piece))
      .join('')}$`,
  )

const matchesFrame = (entry: ArtifactEntry, frame: WorkbenchFrame): boolean =>
  'displayKind' in entry.match && entry.match.displayKind === displayKindOf(frame.display)

/** 按路径、模式或工作区命中的类型不随某张工具卡来去，菜单里常驻。 */
export const isStanding = (entry: ArtifactEntry): boolean =>
  'path' in entry.match || 'pattern' in entry.match || 'workspace' in entry.match

export class ArtifactRegistry {
  private readonly entries: ArtifactEntry[] = []
  /** 模式项按登记顺序，模式在登记时编译一次。 */
  private readonly patterns: { entry: ArtifactEntry; regex: RegExp }[] = []

  register(entry: ArtifactEntry): void {
    this.entries.push(entry)
    if ('pattern' in entry.match) {
      this.patterns.push({ entry, regex: compilePattern(entry.match.pattern) })
    }
  }

  resolve(type: string): ArtifactEntry | undefined {
    return this.entries.find((entry) => entry.type === type)
  }

  autoOpens(type: string): boolean {
    return this.resolve(type)?.autoOpen ?? false
  }

  /** 常驻类型按登记顺序；折叠态菜单据此列行，没有产物的行灰着并给出 empty 说明。 */
  standing(): ArtifactEntry[] {
    return this.entries.filter(isStanding)
  }

  /** 每份文件至多归一个类型：先找确切路径再找模式，两类之间不看登记先后；都没有就不算产物。 */
  matchFiles(files: readonly WorkbenchFile[]): Artifact[] {
    return files.flatMap((file) => {
      const entry =
        this.entries.find(
          (candidate) => 'path' in candidate.match && candidate.match.path === file.path,
        ) ?? this.patterns.find(({ regex }) => regex.test(file.path))?.entry
      if (entry === undefined) return []
      const source = { kind: 'file', path: file.path, version: file.version } as const
      return [
        { id: fileArtifactId(file.path), source, title: entry.title(source), type: entry.type },
      ]
    })
  }

  matchWorkspace(files: readonly WorkbenchFile[]): Artifact[] {
    const entry = this.entries.find((candidate) => 'workspace' in candidate.match)
    if (entry === undefined || files.length === 0) return []
    const source = { fileCount: files.length, kind: 'workspace' } as const
    return [{ id: WORKSPACE_ARTIFACT_ID, source, title: entry.title(source), type: entry.type }]
  }

  matchFrames(frames: readonly WorkbenchFrame[]): Artifact[] {
    return frames.flatMap((frame) => {
      const entry = this.entries.find((candidate) => matchesFrame(candidate, frame))
      if (entry === undefined) return []
      const source: FrameArtifactSource = {
        kind: 'frame',
        metadata: frame.metadata,
        toolCallId: frame.toolCallId,
        view: frame.view,
        ...(frame.display === undefined ? {} : { display: frame.display }),
        ...(frame.agentRefs === undefined ? {} : { agentRefs: frame.agentRefs }),
      }
      return [
        {
          id: frameArtifactId(frame.toolCallId),
          source,
          title: entry.title(source),
          type: entry.type,
        },
      ]
    })
  }
}

/** 三个来源合成一份列表：被认领的文件、整个工作区、工具帧。 */
export const composeArtifacts = (
  registry: ArtifactRegistry,
  files: readonly WorkbenchFile[],
  frames: readonly WorkbenchFrame[],
): Artifact[] => [
  ...registry.matchFiles(files),
  ...registry.matchWorkspace(files),
  ...registry.matchFrames(frames),
]

/** 优先选择请求的产物，其次为首个 autoOpen 类型；都没有就不选，宿主给选择页。 */
export const pickArtifact = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  requestedId: string | undefined,
): Artifact | undefined =>
  artifacts.find((artifact) => artifact.id === requestedId) ??
  artifacts.find((artifact) => registry.autoOpens(artifact.type))
