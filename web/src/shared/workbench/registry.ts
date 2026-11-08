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
  'path' in entry.match || 'pattern' in entry.match || 'workspace' in entry.match

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

export const composeArtifacts = (
  registry: ArtifactRegistry,
  files: readonly WorkbenchFile[],
  frames: readonly WorkbenchFrame[],
): Artifact[] => [
  ...registry.matchFiles(files),
  ...registry.matchWorkspace(files),
  ...registry.matchFrames(frames),
]

export const pickArtifact = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  requestedId: string | undefined,
): Artifact | undefined =>
  artifacts.find((artifact) => artifact.id === requestedId) ??
  artifacts.find((artifact) => registry.autoOpens(artifact.type))
