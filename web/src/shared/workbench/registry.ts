import {
  fileArtifactId,
  frameArtifactId,
  WORKSPACE_ARTIFACT_ID,
  type Artifact,
  type ArtifactEntry,
  type CreatableEntry,
  type FrameArtifactSource,
  type WorkbenchFile,
  type WorkbenchFrame,
} from './artifact'

const displayKindOf = (display: unknown): string | undefined => {
  if (typeof display !== 'object' || display === null) return undefined
  const kind = (display as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : undefined
}

const GLOB_TOKENS = new Map([
  ['*', '[^/]*'],
  ['**', '.*'],
  ['**/', '(?:.*/)?'],
])

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const compilePattern = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/|\*\*|\*)/)
      .map((piece) => GLOB_TOKENS.get(piece) ?? escapeRegExp(piece))
      .join('')}$`,
  )

const matchesFrame = (entry: ArtifactEntry, frame: WorkbenchFrame): boolean =>
  'displayKind' in entry.match && entry.match.displayKind === displayKindOf(frame.display)

export const isStanding = (entry: ArtifactEntry): boolean =>
  'path' in entry.match ||
  'pattern' in entry.match ||
  'anyPath' in entry.match ||
  'workspace' in entry.match

export class ArtifactRegistry {
  private readonly entries: ArtifactEntry[] = []
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

  standing(): ArtifactEntry[] {
    return this.entries.filter(isStanding)
  }

  /** 返回已配置 `create` 的可新建产物类型，按注册顺序排列。 */
  creatable(): CreatableEntry[] {
    return this.entries.filter((entry): entry is CreatableEntry => entry.create !== undefined)
  }

  /**
   * 解析工作区路径 `path` 归属的产物（不校验文件是否存在或只读可见性）：依次按精确路径、通配模式、`anyPath`
   * 与 `anyPath.dir` 目录前缀匹配，未命中时返回 `undefined`。`document` 为 `true` 表示该文件即为产物主文档，
   * 仅因位于 `dir` 目录下而归属时为 `false`。
   */
  ownerOf(
    path: string,
  ): (Pick<Artifact, 'id' | 'title' | 'type'> & { document: boolean }) | undefined {
    const file = this.fileEntryOf(path)
    if (file !== undefined) {
      return {
        document: true,
        id: fileArtifactId(path),
        title: file.title({ kind: 'file', path, version: 0 }),
        type: file.type,
      }
    }
    const listed = this.entries.find(
      (entry) => 'anyPath' in entry.match && entry.match.anyPath.includes(path),
    )
    const owner =
      listed ??
      this.entries.find(
        (entry) =>
          'anyPath' in entry.match &&
          entry.match.dir !== undefined &&
          path.startsWith(`${entry.match.dir}/`),
      )
    return owner === undefined
      ? undefined
      : {
          document: listed !== undefined,
          id: owner.type,
          title: owner.title({ kind: 'paths', paths: [path] }),
          type: owner.type,
        }
  }

  private fileEntryOf(path: string): ArtifactEntry | undefined {
    return (
      this.entries.find(
        (candidate) => 'path' in candidate.match && candidate.match.path === path,
      ) ?? this.patterns.find(({ regex }) => regex.test(path))?.entry
    )
  }

  matchFiles(files: readonly WorkbenchFile[]): Artifact[] {
    return files.flatMap((file) => {
      const entry = this.fileEntryOf(file.path)
      if (entry === undefined) return []
      const source = { kind: 'file', path: file.path, version: file.version } as const
      return [
        { id: fileArtifactId(file.path), source, title: entry.title(source), type: entry.type },
      ]
    })
  }

  matchAnyPath(files: readonly WorkbenchFile[]): Artifact[] {
    return this.entries.flatMap((entry) => {
      if (!('anyPath' in entry.match)) return []
      const listed = entry.match.anyPath
      const paths = files.map((file) => file.path).filter((path) => listed.includes(path))
      if (paths.length === 0) return []
      const source = { kind: 'paths', paths } as const
      return [{ id: entry.type, source, title: entry.title(source), type: entry.type }]
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

/**
 * 汇总当前工作台内的全部产物，按页签展示顺序排列：路径匹配文件、`anyPath` 产物、工作区、工具帧。
 * `readOnly` 为 `true` 时过滤掉标记为 `hiddenWhenReadOnly` 的类型。
 */
export const composeArtifacts = (
  registry: ArtifactRegistry,
  files: readonly WorkbenchFile[],
  frames: readonly WorkbenchFrame[],
  readOnly: boolean,
): Artifact[] =>
  [
    ...registry.matchFiles(files),
    ...registry.matchAnyPath(files),
    ...registry.matchWorkspace(files),
    ...registry.matchFrames(frames),
  ].filter((artifact) => !readOnly || registry.resolve(artifact.type)?.hiddenWhenReadOnly !== true)

export const pickArtifact = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  requestedId: string | undefined,
): Artifact | undefined =>
  artifacts.find((artifact) => artifact.id === requestedId) ??
  artifacts.find((artifact) => registry.autoOpens(artifact.type))
