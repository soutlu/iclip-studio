import type {
  LibraryScript,
  LibraryShotGroup,
  LibraryTake,
  LibraryVersionOut,
  LibraryVideo,
} from './library.api'

export const durationSecondsOf = (durationMs: number | null, take: LibraryTake): number | null => {
  if (durationMs !== null) return durationMs / 1000
  if (take.seconds !== null && take.seconds > 0) return take.seconds
  return take.script?.timeline.at(-1)?.end ?? null
}

export const formatClock = (seconds: number): string => {
  const total = Math.max(1, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export const openingTextOf = (take: LibraryTake): string => {
  const text = take.script?.timeline[0]?.prompt ?? take.prompt
  return text.replace(/@Image\d+\s?/g, '').trim()
}

export const cardTitleOf = (video: Pick<LibraryVideo, 'title'>): string => video.title ?? '接口提交'

export const cutCountOf = (take: LibraryTake): number | null =>
  take.script === null ? null : take.script.timeline.length

export const formatSecond = (seconds: number): string => String(Math.round(seconds * 10) / 10)

export type Keyframe = {
  index: number
  start: number
  end: number
  at: number
  prompt: string | null
}

const uniformFrameCount = (seconds: number): number =>
  Math.min(8, Math.max(4, Math.round(seconds / 2)))

export const keyframesOf = (take: LibraryTake, seconds: number | null): Keyframe[] => {
  if (take.script !== null) {
    return take.script.timeline.map((cut, order) => ({
      at: (cut.start + cut.end) / 2,
      end: cut.end,
      index: order + 1,
      prompt: cut.prompt,
      start: cut.start,
    }))
  }
  if (seconds === null || seconds <= 0) return []
  const count = uniformFrameCount(seconds)
  const span = seconds / count
  return Array.from({ length: count }, (_, order) => ({
    at: (order + 0.5) * span,
    end: (order + 1) * span,
    index: order + 1,
    prompt: null,
    start: order * span,
  }))
}

export type PromptSegment = { start: number } & (
  { kind: 'text'; text: string } | { kind: 'image'; number: number; url: string }
)

export const promptSegmentsOf = (
  text: string,
  referenceImageUrls: readonly string[],
): PromptSegment[] => {
  const segments: PromptSegment[] = []
  let start = 0
  for (const part of text.split(/(@Image\d+)/)) {
    if (part !== '') {
      const number = Number(/^@Image(\d+)$/.exec(part)?.[1])
      const url = number > 0 ? referenceImageUrls[number - 1] : undefined
      segments.push(
        url === undefined
          ? { kind: 'text', start, text: part }
          : { kind: 'image', number, start, url },
      )
    }
    start += part.length
  }
  return segments
}

export const cutIndexAt = (script: LibraryScript, seconds: number): number =>
  script.timeline.findIndex((cut) => seconds >= cut.start && seconds < cut.end)

export type LibraryVersion = LibraryVersionOut & { label: string }

export const versionsOf = (group: LibraryShotGroup): LibraryVersion[] =>
  group.versions.map((version, order) => ({ ...version, label: `第 ${order + 1} 版` }))

export const groupNamesOf = (groups: readonly LibraryShotGroup[]): string[] => {
  const unnumbered = groups.filter((group) => group.shotIndex === null).length
  let seen = 0
  return groups.map((group) => {
    if (group.shotIndex !== null) return String(group.shotIndex)
    seen += 1
    return unnumbered > 1 ? `无镜号 ${seen}` : '无镜号'
  })
}
