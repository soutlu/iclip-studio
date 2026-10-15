import type { GenerationJob } from '../storyboard.api'
import { roundToMs, type Clip } from './draft'
import { isEditSegment } from './edit-chain'

/** 基底上的一个精确编辑区间。V1 是基底原区间，edits 按提交先后对应 V2、V3…… */
export type ClipVersionGroup = {
  readonly key: string
  readonly baseJobId: string
  readonly start: number
  readonly end: number
  /** 包含生成中与失败的尝试，状态改变不会使后续版本重新编号。 */
  readonly edits: readonly GenerationJob[]
}

const rangeKey = (baseJobId: string, startMs: number, endMs: number): string =>
  `${baseJobId}@${startMs}-${endMs}`

/** 只投影直接基于此成片的候选；来源与基底区间就是版本组的身份，不追溯编辑链。 */
export const groupsForBase = (
  baseJobId: string,
  jobs: readonly GenerationJob[],
): readonly ClipVersionGroup[] => {
  const groups = new Map<string, ClipVersionGroup & { edits: GenerationJob[] }>()
  const edits = jobs
    .filter(isEditSegment)
    .filter((job) => job.sourceJobId === baseJobId)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
    )
  for (const edit of edits) {
    const key = rangeKey(baseJobId, edit.rangeStartMs, edit.rangeEndMs)
    const group = groups.get(key)
    if (group !== undefined) {
      group.edits.push(edit)
    } else {
      groups.set(key, {
        key,
        baseJobId,
        start: edit.rangeStartMs / 1000,
        end: edit.rangeEndMs / 1000,
        edits: [edit],
      })
    }
  }
  return [...groups.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
}

/** 查基底的精确区间；部分区间不能使用包含它的整组候选。 */
export const groupForRange = (
  range: { start: number; end: number },
  baseJobId: string,
  jobs: readonly GenerationJob[],
): ClipVersionGroup | undefined => {
  const key = rangeKey(baseJobId, Math.round(range.start * 1000), Math.round(range.end * 1000))
  return groupsForBase(baseJobId, jobs).find((group) => group.key === key)
}

/** 将实际使用的媒体范围线性映射回基底；裁剪或拆分结果只占原始区间的对应部分。
 * 生成时长未知时不能推断，调用方可提供已经探测到的实际时长（秒）。 */
export const baseRangeForClip = (
  clip: Clip,
  baseJobId: string,
  jobs: readonly GenerationJob[],
  durationOf?: (job: GenerationJob) => number | undefined,
): { start: number; end: number } | undefined => {
  if (clip.sourceJobId === baseJobId)
    return { start: roundToMs(clip.start), end: roundToMs(clip.end) }
  const edit = jobs.find((job) => job.id === clip.sourceJobId)
  if (edit === undefined || !isEditSegment(edit) || edit.sourceJobId !== baseJobId) return undefined
  const duration =
    durationOf?.(edit) ?? (edit.durationMs === null ? undefined : edit.durationMs / 1000)
  if (duration === undefined || duration <= 0 || clip.end > duration + 0.001) return undefined
  const baseStart = edit.rangeStartMs / 1000
  const span = (edit.rangeEndMs - edit.rangeStartMs) / 1000
  const start = roundToMs(baseStart + (clip.start / duration) * span)
  const end = roundToMs(baseStart + (Math.min(clip.end, duration) / duration) * span)
  return end > start ? { start, end } : undefined
}

/** 按当前片段实际覆盖的基底范围查候选；不把裁剪后的一小段误认作整组。 */
export const groupForClip = (
  clip: Clip,
  baseJobId: string,
  jobs: readonly GenerationJob[],
  durationOf?: (job: GenerationJob) => number | undefined,
): ClipVersionGroup | undefined => {
  const range = baseRangeForClip(clip, baseJobId, jobs, durationOf)
  return range === undefined ? undefined : groupForRange(range, baseJobId, jobs)
}
